import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addTask,
  dataVersion,
  deleteTask,
  listProjects,
  listTasks,
  updateTask,
} from "./db.js";

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
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
