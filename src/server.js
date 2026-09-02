import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addProject,
  addTask,
  dataVersion,
  deleteProject,
  deleteTask,
  getTask,
  listProjects,
  listTasks,
  updateTask,
} from "./db.js";
import {
  dispatchTask,
  dispatchToDesktop,
  guessProjectPath,
  listRuns,
  loadProjectPaths,
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
      sendJson(res, 200, listTasks({ project, includeDone: true }));
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
    if (req.method === "DELETE" && projectMatch) {
      // 空グループの登録解除のみ。タスクが残っていれば db 側で拒否される
      sendJson(res, 200, { removed: deleteProject(decodeURIComponent(projectMatch[1])) });
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
      const resumeSession =
        body.resume && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(task.session || "")
          ? task.session
          : null;
      if (body.resume && !resumeSession) {
        sendJson(res, 400, { error: "このタスクには登録元セッションが記録されていません" });
        return;
      }
      const cwd =
        (body.cwd || "").trim() ||
        (resumeSession && task.origin_path) ||
        loadProjectPaths()[task.project] ||
        guessProjectPath(task.project);
      if (!cwd) {
        sendJson(res, 400, { error: "作業ディレクトリが未設定です", code: "need_cwd" });
        return;
      }
      // デスクトップアプリ(Claude Code / Cowork)へ受け渡すモード
      if (body.target === "desktop" || body.target === "cowork") {
        const result = dispatchToDesktop(id, {
          cwd,
          app: body.target === "cowork" ? "cowork" : "code",
        });
        saveProjectPath(task.project, result.cwd);
        broadcast();
        sendJson(res, 202, result);
        return;
      }
      const run = await dispatchTask(id, { cwd, mode: body.mode, resumeSession }, broadcast);
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
        sendJson(res, 200, updateTask(id, body));
        broadcast();
        return;
      }
      if (req.method === "DELETE") {
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
