#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addProject,
  addTask,
  deleteTask,
  getTask,
  listProjects,
  listTaskSessions,
  listTasks,
  recordTaskSession,
} from "./db.js";
import { maybeRegisterProjectPath } from "./dispatch.js";
import { updateTaskSynced } from "./notion.js";
import {
  claudeTranscriptPath,
  detectClaudeSession,
  detectCodexSession,
  withActivity,
} from "./sessions.js";

const server = new McpServer({ name: "taskdeck", version: "0.3.0" });

// 呼び出し元のハーネス。MCP の initialize で送られてくる clientInfo.name で見分ける
function callerAgent() {
  const name = server.server.getClientVersion()?.name || "";
  if (/codex/i.test(name)) return "codex";
  if (/claude/i.test(name)) return "claude";
  return process.env.CODEX_HOME || process.env.CODEX_SANDBOX ? "codex" : "claude";
}

// 呼び出し元セッションをタスクに紐付ける(見つからなければ何もしない。
// 会話ログのスキャンでも後から紐付くので、ここは早めに表示するためのもの)
function linkCallerSession(taskId) {
  const cwd = process.cwd();
  const agent = callerAgent();
  if (agent === "codex") {
    const found = detectCodexSession(cwd);
    if (!found) return null;
    return recordTaskSession({ taskId, agent, sessionId: found.sessionId, cwd: found.cwd || cwd, transcriptPath: found.transcriptPath, via: "mcp" });
  }
  const sessionId = detectClaudeSession(cwd);
  if (!sessionId) return null;
  return recordTaskSession({ taskId, agent, sessionId, cwd, transcriptPath: claudeTranscriptPath(cwd, sessionId), via: "mcp" });
}

// AI に返すタスク。紐付いたセッションのうち作業中のものを working_in に出し、
// 他のエージェントがすでに手を付けているか分かるようにする
function view(task) {
  if (!task) return task;
  const sessions = withActivity(listTaskSessions(task.id));
  const out = { ...task };
  if (!out.notion_page_id) {
    delete out.notion_page_id; delete out.notion_url; delete out.notion_source_id; delete out.external_status;
  }
  if (sessions.length) {
    out.sessions = sessions.slice(0, 5).map((s) => ({
      agent: s.agent, session_id: s.session_id, cwd: s.cwd, active: s.active, last_activity_at: s.last_activity_at,
    }));
    out.working_in = out.sessions.filter((s) => s.active);
  }
  return out;
}

const json = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const statusEnum = z.enum(["todo", "doing", "done"]);
const priorityEnum = z.enum(["", "high", "medium", "low"]);

server.tool(
  "task_add",
  "Add one or more tasks to the shared kanban board. Use this whenever you notice work that should be done later (improvements, security risks, refactors, follow-ups) so humans and agents can track it.",
  {
    tasks: z
      .array(
        z.object({
          title: z.string().describe("Short imperative task title"),
          notes: z.string().optional().describe("Details, context, file paths. Markdown is rendered in the UI; tasks edited in the UI may store notes as simple HTML"),
          status: statusEnum.optional().describe("Defaults to 'todo'"),
          priority: priorityEnum.optional().describe("Priority badge; '' (default) means none"),
        })
      )
      .min(1),
    project: z
      .string()
      .optional()
      .describe("Project/group name, e.g. the repository name. Defaults to 'inbox'."),
    session: z.string().optional().describe("Optional session identifier for filtering"),
  },
  async ({ tasks, project, session }) => {
    const cwd = process.cwd();
    // session 未指定なら呼び出し元Claudeセッションを自動記録し、
    // UI側で「登録元セッションの続きで実行(--resume)」できるようにする
    const originSession = session ?? detectClaudeSession(cwd);
    const created = tasks.map((t) =>
      addTask({ ...t, project, session: originSession, origin_path: cwd })
    );
    // cwd をプロジェクトのリポジトリとしても自動で紐付ける(UIの🤖依頼で使用)
    maybeRegisterProjectPath(project ?? created[0]?.project, cwd);
    return json(created);
  }
);

server.tool(
  "task_list",
  "List tasks on the board (local tasks and tasks synced from the user's Notion databases). Call at the start of a session (filtered by project) to see open work. A task whose working_in is non-empty is already being worked on in another live agent session; do not start it unless the user asks.",
  {
    project: z.string().optional(),
    status: statusEnum.optional(),
    session: z.string().optional(),
    include_done: z.boolean().optional().describe("Default false: hide completed tasks"),
  },
  async ({ project, status, session, include_done }) =>
    json(listTasks({ project, status, session, includeDone: include_done ?? false }).map(view))
);

server.tool(
  "task_start",
  "Tell the board you are starting work on a task now. Marks it 'doing' (also in Notion for Notion tasks) and links this agent session to the task so humans can see which AI is working on it and where. Call this before you start working on any board task.",
  {
    id: z.number().int(),
  },
  async ({ id }) => {
    const task = getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    const session = linkCallerSession(id);
    let warning;
    let updated = task;
    try {
      updated = await updateTaskSynced(id, { status: "doing" });
    } catch (err) {
      warning = `ステータスを Notion に書き戻せませんでした: ${err.message}`;
    }
    return json({ task: view(updated), session, ...(warning ? { warning } : {}) });
  }
);

server.tool(
  "task_update",
  "Update a task: change status (todo/doing/done), title, notes, project, or priority. Prefer task_start when starting work, 'done' when finished.",
  {
    id: z.number().int(),
    title: z.string().optional(),
    notes: z.string().optional(),
    status: statusEnum.optional(),
    project: z.string().optional(),
    priority: priorityEnum.optional().describe("'' clears the priority"),
  },
  async ({ id, ...fields }) => {
    if (fields.status === "doing") linkCallerSession(id);
    return json(view(await updateTaskSynced(id, fields)));
  }
);

server.tool(
  "task_done",
  "Mark one or more tasks as done.",
  { ids: z.array(z.number().int()).min(1) },
  async ({ ids }) => {
    const done = [];
    for (const id of ids) {
      linkCallerSession(id);
      done.push(view(await updateTaskSynced(id, { status: "done" })));
    }
    return json(done);
  }
);

server.tool(
  "task_delete",
  "Delete a task permanently. Prefer task_done unless the task was created by mistake.",
  { id: z.number().int() },
  async ({ id }) => {
    const task = getTask(id);
    if (task?.notion_page_id) throw new Error("Notion のタスクは削除できません。完了にするなら task_done を使ってください");
    const removed = deleteTask(id);
    return json({ removed, task: task ?? null });
  }
);

server.tool(
  "project_add",
  "Create an empty project (group) on the board so it is visible everywhere (web UI, macOS app, other agents) before any task is added to it. Adding a task with a new project name also creates the group implicitly, so use this only when you want the empty group itself.",
  {
    name: z.string().describe("Project/group name, e.g. the repository name"),
  },
  async ({ name }) => {
    const project = addProject(name);
    // 呼び出し元の cwd をこのグループのリポジトリとして紐付ける(UIの🤖依頼で使用)
    maybeRegisterProjectPath(project.project, process.cwd());
    return json(project);
  }
);

server.tool(
  "project_list",
  "List all projects (groups) with open/total task counts.",
  {},
  async () => json(listProjects())
);

const transport = new StdioServerTransport();
await server.connect(transport);
