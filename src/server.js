import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addProject,
  addTask,
  dataVersion,
  deleteProject,
  deleteProjectWithTasks,
  renameProject,
  deleteTask,
  getTask,
  getNotionSource,
  listNotionSources,
  listProjects,
  listTaskSessions,
  listTasks,
  saveNotionSource,
  deleteNotionSource,
  setNotionDisplayProps,
} from "./db.js";
import { inspectDatabase, loadToken, notion, previewSource, saveToken, syncAll, syncSource, updateTaskSynced } from "./notion.js";
import { scanTranscripts, withActivity } from "./sessions.js";
import {
  dispatchTask,
  dispatchToDesktop,
  guessProjectPath,
  listRuns,
  loadProjectPaths,
  renameProjectPath,
  saveProjectPath,
  stopRun,
} from "./dispatch.js";

const PORT = Number(process.env.TASKDECK_PORT || 4747);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const indexHtml = readFileSync(join(publicDir, "index.html"));

const sseClients = new Set();
function broadcast() {
  for (const res of sseClients) res.write("data: changed\n\n");
}
// data_version only reflects writes from other connections (e.g. the MCP
// process); the server's own API writes call broadcast() directly.
let lastVersion = dataVersion();
setInterval(() => {
  const v = dataVersion();
  if (v !== lastVersion) {
    lastVersion = v;
    broadcast();
  }
}, 1000).unref();

// ---- バックグラウンド: Notion 同期と会話ログのスキャン ----
const isRunning = (taskId) => listRuns().some((r) => r.taskId === taskId && r.status === "running");
const NOTION_SYNC_MS = Number(process.env.TASKDECK_NOTION_SYNC_MS || 60 * 1000);
const SCAN_MS = Number(process.env.TASKDECK_SCAN_MS || 30 * 1000);
let notionSyncing = null;
function runNotionSync(opts = {}) {
  if (!notionSyncing) {
    notionSyncing = syncAll({ ...opts, isRunning })
      .then((r) => { if (r.changed) broadcast(); return r; })
      .finally(() => { notionSyncing = null; });
  }
  return notionSyncing;
}
function runScan() {
  try {
    if (scanTranscripts() > 0) broadcast();
  } catch (err) {
    console.error("会話ログのスキャンに失敗:", err.message);
  }
}
if (NOTION_SYNC_MS > 0) {
  setTimeout(() => runNotionSync().catch(() => {}), 2000).unref();
  setInterval(() => runNotionSync().catch(() => {}), NOTION_SYNC_MS).unref();
}
if (SCAN_MS > 0) {
  setTimeout(runScan, 1000).unref();
  setInterval(runScan, SCAN_MS).unref();
}
// 「作業中」表示は会話ログの更新時刻で決まるので、書き込みが無くても定期的に画面を更新させる
setInterval(broadcast, 60 * 1000).unref();

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// ---- ブラウザ経由の攻撃 (CSRF / DNS rebinding) 対策 ----
// このサーバーは 127.0.0.1 にしか bind しないが、利用者のブラウザで開いた
// 任意のサイトの JavaScript は localhost に向けてリクエストを送れる。
// 書き込み API を叩かれると、攻撃者の書いたタスクを `claude` に実行させられるため、
//   1. Host が自分自身 (localhost / 127.0.0.1 / [::1] + ポート) でなければ拒否
//   2. Origin が付いていれば同じく自分自身でなければ拒否 (ブラウザは他サイトからの
//      POST に必ず Origin を付ける。Origin: null も拒否)
//   3. Sec-Fetch-Site が cross-site なら拒否
//   4. 本文を伴う書き込みは Content-Type: application/json を必須にする
//      (CORS プリフライト無しで送れる「単純リクエスト」を弾く)
// macOS アプリは 127.0.0.1、Windows のアプリモードは localhost で接続するので両方許可する。
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

function isLocalHost(host) {
  return typeof host === "string" && LOCAL_HOSTS.has(host.toLowerCase());
}

function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && isLocalHost(u.host);
  } catch {
    return false;
  }
}

// 通せないリクエストなら {status, error} を返す。通せるなら null。
function rejectCrossSite(req) {
  const method = req.method || "GET";
  if (!isLocalHost(req.headers.host)) {
    return { status: 403, error: "Host ヘッダが localhost ではありません" };
  }
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  const origin = req.headers.origin;
  if (origin !== undefined && !isLocalOrigin(origin)) {
    return { status: 403, error: "別のサイトからの書き込みは受け付けません" };
  }
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    return { status: 403, error: "別のサイトからの書き込みは受け付けません" };
  }
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      return { status: 415, error: "Content-Type は application/json にしてください" };
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  const rejected = rejectCrossSite(req);
  if (rejected) {
    sendJson(res, rejected.status, { error: rejected.error });
    return;
  }
  try {
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(indexHtml);
      return;
    }
    if (req.method === "GET" && pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("data: hello\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.method === "GET" && pathname === "/api/tasks") {
      const project = url.searchParams.get("project") || undefined;
      const tasks = listTasks({ project, includeDone: true });
      // 紐付いた AI セッション(新しい順)を各タスクに添える
      const byTask = new Map();
      for (const s of withActivity(listTaskSessions())) {
        if (!byTask.has(s.task_id)) byTask.set(s.task_id, []);
        byTask.get(s.task_id).push(s);
      }
      sendJson(res, 200, tasks.map((t) => ({ ...t, sessions: byTask.get(t.id) || [] })));
      return;
    }
    // ---- Notion 連携 ----
    if (req.method === "GET" && pathname === "/api/notion") {
      sendJson(res, 200, { configured: !!loadToken(), sources: listNotionSources() });
      return;
    }
    if (req.method === "POST" && pathname === "/api/notion/token") {
      const body = await readBody(req);
      const token = String(body.token || "").trim();
      if (!token) {
        sendJson(res, 400, { error: "トークンを入力してください" });
        return;
      }
      // 保存前に有効か確かめる
      const me = await notion("GET", "/users/me", null, { token });
      saveToken(token);
      sendJson(res, 200, { configured: true, bot: me.name || "" });
      return;
    }
    if (req.method === "POST" && pathname === "/api/notion/inspect") {
      const body = await readBody(req);
      sendJson(res, 200, await inspectDatabase(body.url));
      return;
    }
    if (req.method === "POST" && pathname === "/api/notion/preview") {
      sendJson(res, 200, await previewSource(await readBody(req)));
      return;
    }
    if (req.method === "POST" && pathname === "/api/notion/sources") {
      const body = await readBody(req);
      const info = await inspectDatabase(body.url);
      if (!body.people_prop || !info.people_props.includes(body.people_prop)) {
        sendJson(res, 400, { error: "担当者のプロパティを選んでください" });
        return;
      }
      // 一覧から選ぶか、Notion のユーザー ID を直接入力する(ユーザー情報の権限が無いときのため)
      const personId = String(body.person_id || "").trim().toLowerCase();
      if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(personId)) {
        sendJson(res, 400, { error: "あなたの Notion ユーザー ID を選ぶか入力してください" });
        return;
      }
      const hex = personId.replace(/-/g, "");
      body.person_id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const statusProp = body.status_prop && info.status_props.includes(body.status_prop) ? body.status_prop : null;
      const def = statusProp ? info.status_defs[statusProp] : null;
      const writeback = { ...(def?.writeback || {}) };
      for (const col of ["todo", "doing", "done"]) {
        if (body.writeback?.[col] && def?.options.includes(body.writeback[col])) writeback[col] = body.writeback[col];
      }
      const person = info.people.find((p) => p.id === body.person_id);
      const source = saveNotionSource({
        database_id: info.database_id,
        data_source_id: info.data_source_id,
        title: info.title,
        url: info.url,
        title_prop: info.title_prop,
        people_prop: body.people_prop,
        person_id: body.person_id,
        // 名前が取れない人(ID しか返らない)は画面から来た表示名(「あなた」)を使う
        person_name: (person?.named && person.name) || body.person_name || "あなた",
        status_prop: statusProp,
        status_type: def?.type || null,
        status_map: def?.status_map || {},
        writeback,
        project_prop: body.project_prop && info.project_props.includes(body.project_prop) ? body.project_prop : null,
      });
      const result = await syncSource(source.id, { full: true, isRunning });
      broadcast();
      sendJson(res, 201, { source: getNotionSource(source.id), ...result });
      return;
    }
    if (req.method === "POST" && pathname === "/api/notion/sync") {
      const result = await runNotionSync({ force: true });
      sendJson(res, 200, { ...result, sources: listNotionSources() });
      return;
    }
    const sourceMatch = pathname.match(/^\/api\/notion\/sources\/(\d+)$/);
    if (req.method === "PATCH" && sourceMatch) {
      // 表示するプロパティと順番: [{ name, card }] か null(おまかせ)
      const body = await readBody(req);
      const list = Array.isArray(body.display_props)
        ? body.display_props
            .filter((p) => p && typeof p.name === "string")
            .map((p) => ({ name: p.name, card: !!p.card }))
        : null;
      const updated = setNotionDisplayProps(Number(sourceMatch[1]), list);
      if (!updated) {
        sendJson(res, 404, { error: "同期元が見つかりません" });
        return;
      }
      broadcast();
      sendJson(res, 200, updated);
      return;
    }
    if (req.method === "DELETE" && sourceMatch) {
      sendJson(res, 200, { removed: deleteNotionSource(Number(sourceMatch[1])) });
      broadcast();
      return;
    }
    if (req.method === "GET" && pathname === "/api/projects") {
      sendJson(res, 200, listProjects());
      return;
    }
    if (req.method === "POST" && pathname === "/api/projects") {
      const body = await readBody(req);
      sendJson(res, 201, addProject(body.name ?? body.project));
      broadcast();
      return;
    }
    const projectMatch = pathname.match(/^\/api\/projects\/(.+)$/);
    if (req.method === "PATCH" && projectMatch) {
      const body = await readBody(req);
      const result = renameProject(decodeURIComponent(projectMatch[1]), body.name ?? "");
      try { renameProjectPath(result.from, result.to); } catch {}
      broadcast();
      sendJson(res, 200, result);
      return;
    }
    if (req.method === "DELETE" && projectMatch) {
      const name = decodeURIComponent(projectMatch[1]);
      if (url.searchParams.get("with_tasks") === "1") {
        // タスクごと削除。Notion のタスクと実行中のタスクは残す
        sendJson(res, 200, deleteProjectWithTasks(name, { skip: isRunning }));
      } else {
        // 空グループの登録解除のみ。タスクが残っていれば db 側で拒否される
        sendJson(res, 200, { removed: deleteProject(name) });
      }
      broadcast();
      return;
    }
    if (req.method === "GET" && pathname === "/api/runs") {
      sendJson(res, 200, listRuns());
      return;
    }
    if (req.method === "GET" && pathname === "/api/project-paths") {
      // 保存済みの紐付けに、未登録プロジェクトのリポジトリ推測を合成して返す
      const merged = { ...loadProjectPaths() };
      for (const { project } of listProjects()) {
        if (!merged[project]) {
          const guess = guessProjectPath(project);
          if (guess) merged[project] = guess;
        }
      }
      sendJson(res, 200, merged);
      return;
    }
    const dispatchMatch = pathname.match(/^\/api\/tasks\/(\d+)\/dispatch$/);
    if (req.method === "POST" && dispatchMatch) {
      const id = Number(dispatchMatch[1]);
      const body = await readBody(req);
      const task = getTask(id);
      if (!task) {
        sendJson(res, 404, { error: `task ${id} not found` });
        return;
      }
      // resume: 登録元セッションの続きとして実行する。
      // セッションは登録元ディレクトリに保存されているため、cwd もそこを優先する。
      // resume_session があれば紐付いたセッションの続きとして実行する(タスクに記録済みのものに限る)
      const linked = body.resume_session
        ? listTaskSessions(id).find((s) => s.session_id === body.resume_session && s.agent === "claude")
        : null;
      const resumeSession = linked
        ? linked.session_id
        : body.resume && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(task.session || "")
          ? task.session
          : null;
      if (body.resume && !resumeSession) {
        sendJson(res, 400, { error: "このタスクには登録元セッションが記録されていません" });
        return;
      }
      const cwd =
        (body.cwd || "").trim() ||
        (linked && linked.cwd) ||
        (resumeSession && task.origin_path) ||
        loadProjectPaths()[task.project] ||
        guessProjectPath(task.project);
      if (!cwd) {
        sendJson(res, 400, { error: "作業ディレクトリが未設定です", code: "need_cwd" });
        return;
      }
      // デスクトップアプリ(Claude Code / Cowork)へ受け渡すモード
      if (body.target === "desktop" || body.target === "cowork") {
        const result = await dispatchToDesktop(id, {
          cwd,
          app: body.target === "cowork" ? "cowork" : "code",
        });
        saveProjectPath(task.project, result.cwd);
        broadcast();
        sendJson(res, 202, result);
        return;
      }
      const agent = body.target === "codex" ? "codex" : "claude";
      const run = await dispatchTask(id, { cwd, mode: body.mode, resumeSession, agent }, broadcast);
      saveProjectPath(task.project, run.cwd);
      broadcast();
      sendJson(res, 202, run);
      return;
    }
    const stopMatch = pathname.match(/^\/api\/tasks\/(\d+)\/dispatch\/stop$/);
    if (req.method === "POST" && stopMatch) {
      stopRun(Number(stopMatch[1]));
      broadcast();
      sendJson(res, 200, { stopped: true });
      return;
    }
    if (req.method === "POST" && pathname === "/api/tasks") {
      const body = await readBody(req);
      sendJson(res, 201, addTask(body));
      broadcast();
      return;
    }
    const taskMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (taskMatch) {
      const id = Number(taskMatch[1]);
      if (req.method === "PATCH") {
        const body = await readBody(req);
        sendJson(res, 200, await updateTaskSynced(id, body));
        broadcast();
        return;
      }
      if (req.method === "DELETE") {
        // Notion のミラーは消しても次の同期で戻るうえ、Notion のページは消さない
        if (getTask(id)?.notion_page_id) {
          sendJson(res, 400, { error: "Notion のタスクは Notion 側で削除・担当解除してください" });
          return;
        }
        sendJson(res, 200, { removed: deleteTask(id) });
        broadcast();
        return;
      }
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`taskdeck UI running at http://localhost:${PORT}`);
});
