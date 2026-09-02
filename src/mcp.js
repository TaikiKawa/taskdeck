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
  listTasks,
  updateTask,
} from "./db.js";
import { maybeRegisterProjectPath } from "./dispatch.js";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 呼び出し元の Claude セッションIDを検出する。
// このMCPサーバーはセッションの作業ディレクトリで起動されるため、
// ~/.claude/projects/<dir> 直下で直近更新されたトランスクリプト(.jsonl)の
// ファイル名 = 今まさに動いているセッションのUUID とみなす。
function detectClaudeSession(cwd) {
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  try {
    // Claude Code は cwd の英数字以外を "-" に置換したディレクトリ名を使う。
    // Windows でも同じ規則で、"C:\Users\taiki\dev\taskdeck" は
    // "C--Users-taiki-dev-taskdeck" になる (":" と "\" がそれぞれ "-")。
    // process.cwd() は Windows でバックスラッシュ区切りを返すのでそのまま置換すればよい。
    const dir = join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    const latest = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    // 直近5分以内に動いているものだけ「呼び出し元」とみなす
    if (!latest || Date.now() - latest.m > 5 * 60 * 1000) return null;
    return latest.f.replace(/\.jsonl$/, "");
  } catch {
    return null;
  }
}

const server = new McpServer({ name: "taskdeck", version: "0.1.0" });

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
  "List tasks on the board. Call at the start of a session (filtered by project) to see open work.",
  {
    project: z.string().optional(),
    status: statusEnum.optional(),
    session: z.string().optional(),
    include_done: z.boolean().optional().describe("Default false: hide completed tasks"),
  },
  async ({ project, status, session, include_done }) =>
    json(listTasks({ project, status, session, includeDone: include_done ?? false }))
);

server.tool(
  "task_update",
  "Update a task: change status (todo/doing/done), title, notes, project, or priority. Set status 'doing' when starting work, 'done' when finished.",
  {
    id: z.number().int(),
    title: z.string().optional(),
    notes: z.string().optional(),
    status: statusEnum.optional(),
    project: z.string().optional(),
    priority: priorityEnum.optional().describe("'' clears the priority"),
  },
  async ({ id, ...fields }) => json(updateTask(id, fields))
);

server.tool(
  "task_done",
  "Mark one or more tasks as done.",
  { ids: z.array(z.number().int()).min(1) },
  async ({ ids }) => json(ids.map((id) => updateTask(id, { status: "done" })))
);

server.tool(
  "task_delete",
  "Delete a task permanently. Prefer task_done unless the task was created by mistake.",
  { id: z.number().int() },
  async ({ id }) => {
    const task = getTask(id);
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
