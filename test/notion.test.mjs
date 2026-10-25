// src/notion.js の同期・書き戻しと、src/sessions.js の会話ログスキャンのテスト。
//   npm test
// Notion API は TASKDECK_NOTION_API で向けた手元の偽サーバーで置き換える。
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "taskdeck-notion-test-"));
const claudeDir = join(root, "claude-projects");
const codexDir = join(root, "codex-sessions");
process.env.TASKDECK_DIR = join(root, "data");
process.env.TASKDECK_CLAUDE_PROJECTS = claudeDir;
process.env.TASKDECK_CODEX_SESSIONS = codexDir;
process.env.TASKDECK_NOTION_TOKEN = "test-token";
mkdirSync(process.env.TASKDECK_DIR, { recursive: true });

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const DB_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DS_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const pid = (n) => `cccccccc-cccc-cccc-cccc-${String(n).padStart(12, "0")}`;

// ---- 偽 Notion ----
const pages = new Map();
const patches = [];
function page(n, { title, status, people = [ME], project = "alpha", edited = new Date().toISOString() }) {
  pages.set(pid(n), {
    object: "page", id: pid(n), url: `https://www.notion.so/${pid(n).replace(/-/g, "")}`,
    last_edited_time: edited, archived: false, in_trash: false,
    properties: {
      名前: { type: "title", title: [{ plain_text: title }] },
      ステータス: { type: "status", status: { name: status } },
      担当者: { type: "people", people: people.map((id) => ({ object: "user", id, name: id === ME ? "taiki" : "other" })) },
      案件: { type: "select", select: { name: project } },
    },
  });
}
const dataSource = {
  object: "data_source", id: DS_ID, title: [{ plain_text: "タスク" }],
  properties: {
    名前: { id: "t", name: "名前", type: "title" },
    担当者: { id: "p", name: "担当者", type: "people" },
    案件: { id: "s", name: "案件", type: "select", select: { options: [{ name: "alpha" }] } },
    ステータス: {
      id: "st", name: "ステータス", type: "status",
      status: {
        options: [
          { id: "o1", name: "未着手" }, { id: "o2", name: "進行中" },
          { id: "o3", name: "レビュー中" }, { id: "o4", name: "完了" },
        ],
        groups: [
          { name: "To-do", option_ids: ["o1"] },
          { name: "In progress", option_ids: ["o2", "o3"] },
          { name: "Complete", option_ids: ["o4"] },
        ],
      },
    },
  },
};

let api;
before(async () => {
  api = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, v) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { code: "unauthorized" });
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === `/v1/databases/${DB_ID}`) {
      return send(200, { object: "database", id: DB_ID, title: [{ plain_text: "タスク" }], url: "https://notion.so/db", data_sources: [{ id: DS_ID, name: "タスク" }] });
    }
    if (req.method === "GET" && url.pathname === `/v1/data_sources/${DS_ID}`) return send(200, dataSource);
    if (req.method === "GET" && url.pathname === "/v1/users") {
      return send(200, { results: [{ object: "user", id: ME, type: "person", name: "taiki", person: { email: "t@example.com" } }], has_more: false });
    }
    if (req.method === "POST" && url.pathname === `/v1/data_sources/${DS_ID}/query`) {
      const conds = body.filter ? body.filter.and || [body.filter] : [];
      let results = [...pages.values()].filter((p) =>
        conds.every((c) => {
          if (c.people) return p.properties[c.property].people.some((u) => u.id === c.people.contains);
          if (c.last_edited_time) return p.last_edited_time >= c.last_edited_time.on_or_after;
          return true;
        })
      );
      return send(200, { results, has_more: false });
    }
    if (req.method === "GET" && /^\/v1\/blocks\/.+\/children$/.test(url.pathname)) {
      return send(200, { results: [
        { type: "heading_2", heading_2: { rich_text: [{ plain_text: "目的" }] } },
        { type: "paragraph", paragraph: { rich_text: [{ plain_text: "本文です" }] } },
      ], has_more: false });
    }
    const pm = url.pathname.match(/^\/v1\/pages\/(.+)$/);
    if (req.method === "PATCH" && pm) {
      const p = [...pages.values()].find((x) => x.id.replace(/-/g, "") === pm[1].replace(/-/g, ""));
      if (!p) return send(404, { code: "object_not_found" });
      patches.push(body.properties);
      for (const [k, v] of Object.entries(body.properties)) {
        if (v.status) p.properties[k].status = { name: v.status.name };
        if (v.title) p.properties[k].title = [{ plain_text: v.title[0].text.content }];
      }
      p.last_edited_time = new Date().toISOString();
      return send(200, p);
    }
    send(404, { code: "object_not_found", message: req.url });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  process.env.TASKDECK_NOTION_API = `http://127.0.0.1:${api.address().port}/v1`;
});

after(() => {
  api?.close();
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

// API の向き先を決めてから読み込む
const load = async () => ({
  notion: await import("../src/notion.js"),
  db: await import("../src/db.js"),
  sessions: await import("../src/sessions.js"),
});

describe("Notion 同期", () => {
  it("URL から ID を取り出す", async () => {
    const { notion } = await load();
    assert.deepEqual(
      notion.parseNotionId("https://www.notion.so/alche/Tasks-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?v=0123456789abcdef0123456789abcdef"),
      { kind: "database", id: DB_ID }
    );
    assert.equal(notion.parseNotionId("collection://bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb").kind, "data_source");
    assert.equal(notion.parseNotionId("hello"), null);
  });

  it("ステータスのグループから列への対応と書き戻し先を作る", async () => {
    const { notion } = await load();
    const m = notion.buildStatusMapping(dataSource.properties.ステータス);
    assert.deepEqual(m.status_map, { 未着手: "todo", 進行中: "doing", レビュー中: "doing", 完了: "done" });
    assert.deepEqual(m.writeback, { todo: "未着手", doing: "進行中", done: "完了" });
  });

  it("自分が担当の行だけを取り込み、Notion のステータスを列に割り当てる", async () => {
    const { notion, db } = await load();
    page(1, { title: "企画書を書く", status: "未着手" });
    page(2, { title: "レビュー待ち", status: "レビュー中" });
    page(3, { title: "他人のタスク", status: "未着手", people: [OTHER] });
    page(4, { title: "昔終わった", status: "完了", edited: "2020-01-01T00:00:00.000Z" });
    const info = await notion.inspectDatabase(`https://www.notion.so/x/T-${DB_ID.replace(/-/g, "")}`);
    assert.equal(info.suggested.people_prop, "担当者");
    assert.equal(info.suggested.status_prop, "ステータス");
    assert.equal(info.suggested.project_prop, "案件");
    const def = info.status_defs.ステータス;
    const src = db.saveNotionSource({
      database_id: info.database_id, data_source_id: info.data_source_id, title: info.title, url: info.url,
      title_prop: info.title_prop, people_prop: "担当者", person_id: ME, person_name: "taiki",
      status_prop: "ステータス", status_type: def.type, status_map: def.status_map, writeback: def.writeback,
      project_prop: "案件",
    });
    const r = await notion.syncSource(src.id, { full: true });
    assert.equal(r.fetched, 3);
    const tasks = db.listTasks({});
    assert.deepEqual(tasks.map((t) => [t.title, t.status, t.external_status, t.project]).sort(), [
      ["レビュー待ち", "doing", "レビュー中", "alpha"],
      ["企画書を書く", "todo", "未着手", "alpha"],
    ]);
  });

  it("ボードの変更を Notion に書き戻す（同じ列のステータス同士では書き換えない）", async () => {
    const { notion, db } = await load();
    const plan = db.listTasks({}).find((t) => t.title === "企画書を書く");
    await notion.updateTaskSynced(plan.id, { status: "doing" });
    assert.deepEqual(patches.pop(), { ステータス: { status: { name: "進行中" } } });
    assert.equal(db.getTask(plan.id).external_status, "進行中");

    const review = db.listTasks({}).find((t) => t.title === "レビュー待ち");
    const before = patches.length;
    await notion.updateTaskSynced(review.id, { status: "doing", notes: "ローカルのメモ" });
    assert.equal(patches.length, before, "レビュー中はすでに Doing なので Notion は触らない");
    assert.equal(db.getTask(review.id).notes, "ローカルのメモ");

    await notion.updateTaskSynced(review.id, { title: "レビュー対応" });
    assert.deepEqual(patches.pop(), { 名前: { title: [{ type: "text", text: { content: "レビュー対応" } }] } });
  });

  it("追加前のプレビューで件数と列ごとの内訳を返す", async () => {
    const { notion } = await load();
    const r = await notion.previewSource({
      url: DB_ID, people_prop: "担当者", person_id: ME, status_prop: "ステータス",
    });
    assert.equal(r.total, 3);
    assert.deepEqual(r.by_column, { todo: 0, doing: 2, done: 1 });
  });

  it("名前の取れる人には named が付き、担当件数の多い順に並ぶ", async () => {
    const { notion } = await load();
    const info = await notion.inspectDatabase(DB_ID);
    assert.equal(info.people_named, true);
    assert.equal(info.people[0].id, ME);
    assert.ok(info.people[0].count >= 1);
  });

  it("グループ名を変えても、次の同期で元の名前に戻らない", async () => {
    const { notion, db } = await load();
    const local = db.addTask({ title: "手元のタスク", project: "alpha" });
    const r = db.renameProject("alpha", "セキュリティ");
    assert.equal(r.moved, 3);
    await notion.syncSource(db.listNotionSources()[0].id, { full: true });
    assert.deepEqual([...new Set(db.listTasks({}).map((t) => t.project))], ["セキュリティ"]);
    // もう一度変えても、元の Notion の名前から付け替わる
    db.renameProject("セキュリティ", "AI");
    await notion.syncSource(db.listNotionSources()[0].id, { full: true });
    assert.deepEqual([...new Set(db.listTasks({}).map((t) => t.project))], ["AI"]);
    // 元の名前に戻すと付け替えは消える
    db.renameProject("AI", "alpha");
    assert.equal(db.resolveProjectAlias("alpha"), "alpha");
    db.deleteTask(local.id);
  });

  it("Notion 側の変更と担当外れを次の同期で反映し、ローカルのメモは残す", async () => {
    const { notion, db } = await load();
    pages.get(pid(1)).properties.ステータス.status = { name: "完了" };
    pages.get(pid(2)).properties.担当者.people = [];
    const src = db.listNotionSources()[0];
    await notion.syncSource(src.id, { full: true });
    const tasks = db.listTasks({});
    assert.deepEqual(tasks.map((t) => [t.title, t.status]), [["企画書を書く", "done"]]);
  });
});

describe("プロパティの整形", () => {
  it("日付・数値・人・数式・ロールアップを読める文字列にする", async () => {
    const { notion } = await load();
    const f = (prop) => notion.formatProp("x", prop, { source: { person_id: ME } }).then((r) => r.text);
    assert.equal(await f({ type: "date", date: { start: "2026-10-26", end: "2026-12-18" } }), "2026/10/26 → 2026/12/18");
    assert.equal(await f({ type: "number", number: 11 }), "11");
    assert.equal(await f({ type: "number", number: 0 }), "0");
    assert.equal(await f({ type: "people", people: [{ id: ME }, { id: OTHER }] }), `あなた、メンバー（${OTHER.slice(0, 8)}）`);
    assert.equal(await f({ type: "people", people: [{ id: OTHER, name: "Toshiyuki Wada" }] }), "Toshiyuki Wada");
    assert.equal(await f({ type: "formula", formula: { type: "string", string: "期限切れ" } }), "期限切れ");
    assert.equal(await f({ type: "rollup", rollup: { type: "array", array: [{ type: "checkbox", checkbox: true }] } }), "✓");
  });

  it("同期でプロパティと本文を保存する", async () => {
    const { db } = await load();
    const t = db.listTasks({}).find((x) => x.notion_page_id);
    const props = JSON.parse(t.notion_props);
    assert.deepEqual(props.map((p) => p.name).sort(), ["ステータス", "担当者", "案件"].sort());
    assert.equal(props.find((p) => p.name === "担当者").text, "taiki");
    assert.equal(t.notion_body, "## 目的\n本文です");
  });
});

describe("グループの削除", () => {
  it("タスクごと消し、Notion のタスクと除外指定のタスクは残す", async () => {
    const { db } = await load();
    const a = db.addTask({ title: "x", project: "旅行" });
    const b = db.addTask({ title: "y", project: "旅行", status: "done" });
    const running = db.addTask({ title: "z", project: "旅行" });
    db.upsertNotionTask({ pageId: "f".repeat(32), url: "u", sourceId: 99, title: "n", status: "todo", externalStatus: "未着手", project: "旅行" });
    const r = db.deleteProjectWithTasks("旅行", { skip: (id) => id === running.id });
    assert.deepEqual([r.deleted, r.kept], [2, 2]);
    assert.equal(db.getTask(a.id), undefined);
    assert.equal(db.getTask(b.id), undefined);
    assert.ok(db.getTask(running.id));
  });
});

describe("会話ログのスキャン", () => {
  it("Claude と Codex のセッションをタスクに紐付ける（ツール出力は無視）", async () => {
    const { db, sessions } = await load();
    const a = db.addTask({ title: "A", project: "p" });
    const b = db.addTask({ title: "B", project: "p" });
    const c = db.addTask({ title: "C", project: "p" });
    const notionTask = db.listTasks({}).find((t) => t.notion_page_id);

    const cdir = join(claudeDir, "-Users-me-dev-p");
    mkdirSync(cdir, { recursive: true });
    const claudeId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const cfile = join(cdir, `${claudeId}.jsonl`);
    const L = (o) => JSON.stringify({ sessionId: claudeId, cwd: "/Users/me/dev/p", timestamp: new Date().toISOString(), ...o }) + "\n";
    writeFileSync(cfile,
      L({ type: "user", message: { role: "user", content: `#${a.id} のタスクやって` } }) +
      L({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: `#${c.id} のタスク` }] } }) +
      L({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__taskdeck__task_start", input: { id: b.id } }] } })
    );

    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const xdir = join(codexDir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    mkdirSync(xdir, { recursive: true });
    const codexId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const xfile = join(xdir, `rollout-2026-10-24T10-00-00-${codexId}.jsonl`);
    writeFileSync(xfile,
      JSON.stringify({ type: "session_meta", payload: { id: codexId, cwd: "/Users/me/dev/p" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `これ見て ${notionTask.notion_url}` } }) + "\n"
    );

    sessions.scanTranscripts({ since: 0 });
    const linked = (id) => db.listTaskSessions(id).map((s) => `${s.agent}:${s.session_id}`);
    assert.deepEqual(linked(a.id), [`claude:${claudeId}`]);
    assert.deepEqual(linked(b.id), [`claude:${claudeId}`]);
    assert.deepEqual(linked(c.id), [], "tool_result の中身では紐付けない");
    assert.deepEqual(linked(notionTask.id), [`codex:${codexId}`]);

    // 追記分だけ読む(増分スキャン)
    appendFileSync(xfile, JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", namespace: "taskdeck", name: "task_done", arguments: JSON.stringify({ ids: [c.id] }) },
    }) + "\n");
    sessions.scanTranscripts({ since: 0 });
    assert.deepEqual(linked(c.id), [`codex:${codexId}`]);

    const [s] = sessions.withActivity(db.listTaskSessions(a.id));
    assert.equal(s.active, true, "直近に更新された会話ログは作業中");
    assert.equal(s.title, `#${a.id} のタスクやって`);
  });
});
