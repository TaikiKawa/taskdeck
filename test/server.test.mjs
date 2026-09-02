// src/server.js の起動スモークテストと、ブラウザ経由の攻撃 (CSRF / DNS rebinding) 対策のテスト。
//   npm test
// fetch() は Host ヘッダを上書きできないため node:http を直接使う。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 47000 + Math.floor(Math.random() * 1000);
const dataDir = mkdtempSync(join(tmpdir(), "taskdeck-test-"));
let server;

function call({ method = "GET", path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: PORT, method, path, headers },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const LOCAL = `127.0.0.1:${PORT}`;
const JSON_HEADERS = { host: LOCAL, "content-type": "application/json" };
const task = JSON.stringify({ title: "test task", project: "test" });

before(async () => {
  server = spawn(process.execPath, [join(root, "src", "server.js")], {
    env: { ...process.env, TASKDECK_PORT: String(PORT), TASKDECK_DIR: dataDir },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await call({ path: "/api/projects", headers: { host: LOCAL } });
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});

after(() => {
  server?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("smoke", () => {
  it("creates, lists, updates and deletes a task via the JSON API", async () => {
    const created = await call({ method: "POST", path: "/api/tasks", headers: JSON_HEADERS, body: task });
    assert.equal(created.status, 201);
    const id = created.json.id;
    assert.ok(id > 0);

    const list = await call({ path: "/api/tasks?project=test", headers: { host: LOCAL } });
    assert.equal(list.status, 200);
    assert.ok(list.json.some((t) => t.id === id));

    const done = await call({
      method: "PATCH", path: `/api/tasks/${id}`, headers: JSON_HEADERS, body: JSON.stringify({ status: "done" }),
    });
    assert.equal(done.status, 200);
    assert.equal(done.json.status, "done");

    const removed = await call({ method: "DELETE", path: `/api/tasks/${id}`, headers: { host: LOCAL } });
    assert.equal(removed.status, 200);
    assert.equal(removed.json.removed, true);
  });
});

describe("cross-site protection", () => {
  it("accepts writes from the app's own origins (127.0.0.1 and localhost)", async () => {
    for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]) {
      const r = await call({
        method: "POST", path: "/api/tasks",
        headers: { ...JSON_HEADERS, origin, "sec-fetch-site": "same-origin" }, body: task,
      });
      assert.equal(r.status, 201, `origin ${origin}`);
      await call({ method: "DELETE", path: `/api/tasks/${r.json.id}`, headers: { host: LOCAL } });
    }
  });

  it("rejects writes whose Origin is another site", async () => {
    for (const origin of ["https://evil.example", "http://evil.example", "null", `https://localhost:${PORT}`, `http://localhost:1`]) {
      const r = await call({ method: "POST", path: "/api/tasks", headers: { ...JSON_HEADERS, origin }, body: task });
      assert.equal(r.status, 403, `origin ${origin}`);
    }
  });

  it("rejects the dispatch endpoint from another site before any routing happens", async () => {
    const r = await call({
      method: "POST", path: "/api/tasks/1/dispatch",
      headers: { ...JSON_HEADERS, origin: "https://evil.example" },
      body: JSON.stringify({ mode: "full", cwd: "~" }),
    });
    assert.equal(r.status, 403);
  });

  it("rejects writes flagged cross-site by Sec-Fetch-Site", async () => {
    const r = await call({
      method: "POST", path: "/api/tasks",
      headers: { ...JSON_HEADERS, "sec-fetch-site": "cross-site" }, body: task,
    });
    assert.equal(r.status, 403);
  });

  it("rejects 'simple' requests without a JSON content type (no-cors fetch)", async () => {
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const headers = { host: LOCAL };
      if (type) headers["content-type"] = type;
      const r = await call({ method: "POST", path: "/api/tasks", headers, body: task });
      assert.equal(r.status, 415, `content-type ${type}`);
    }
  });

  it("accepts a JSON content type with a charset parameter", async () => {
    const r = await call({
      method: "POST", path: "/api/tasks",
      headers: { host: LOCAL, "content-type": "Application/JSON; charset=utf-8" }, body: task,
    });
    assert.equal(r.status, 201);
    await call({ method: "DELETE", path: `/api/tasks/${r.json.id}`, headers: { host: LOCAL } });
  });

  it("rejects any request whose Host is not localhost (DNS rebinding)", async () => {
    for (const host of ["evil.example", `evil.example:${PORT}`, "127.0.0.1", `127.0.0.1:${PORT + 1}`]) {
      const get = await call({ path: "/api/tasks", headers: { host } });
      assert.equal(get.status, 403, `GET host ${host}`);
      const post = await call({ method: "POST", path: "/api/tasks", headers: { host, "content-type": "application/json" }, body: task });
      assert.equal(post.status, 403, `POST host ${host}`);
    }
  });

  it("still serves the UI and API on localhost and [::1] hosts", async () => {
    for (const host of [`localhost:${PORT}`, `LOCALHOST:${PORT}`, `[::1]:${PORT}`]) {
      const r = await call({ path: "/api/projects", headers: { host } });
      assert.equal(r.status, 200, `host ${host}`);
    }
    const ui = await call({ path: "/", headers: { host: LOCAL } });
    assert.equal(ui.status, 200);
    assert.match(ui.raw, /<title>taskdeck<\/title>/);
  });
});
