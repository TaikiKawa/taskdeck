// Notion データベースとの同期。
// - 認証はユーザーが作った Notion インテグレーションのトークン (~/.taskdeck/notion.json, 0600)
// - 同期元ごとに「people_prop に自分が入っている行」だけを取り込み、tasks にミラーする
// - ボードで変えたタイトル・ステータスは Notion に書き戻す (Notion が正本)
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  deleteTask,
  getCachedTitle,
  getNotionSource,
  getTaskByNotionPage,
  resolveProjectAlias,
  setCachedTitle,
  getTask,
  listNotionSources,
  listNotionTaskIds,
  markNotionSourceSynced,
  setExternalStatus,
  updateTask,
  upsertNotionTask,
} from "./db.js";

const dataDir = process.env.TASKDECK_DIR || join(homedir(), ".taskdeck");
const tokenFile = join(dataDir, "notion.json");
const API = process.env.TASKDECK_NOTION_API || "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";
// 完了済みは直近この日数に更新されたものだけボードに出す(古い完了タスクで埋まらないように)
const DONE_KEEP_DAYS = 14;
const MAX_PAGES = 1000;

// ---- トークン ----

export function loadToken() {
  if (process.env.TASKDECK_NOTION_TOKEN) return process.env.TASKDECK_NOTION_TOKEN;
  try {
    return JSON.parse(readFileSync(tokenFile, "utf8")).token || "";
  } catch {
    return "";
  }
}

export function saveToken(token) {
  writeFileSync(tokenFile, JSON.stringify({ token }, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch {}
}

// ---- API クライアント ----

export class NotionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function friendlyError(status, code, message) {
  if (status === 401) return "Notion のトークンが無効です。インテグレーションのトークンを確認してください";
  if (status === 404 || code === "object_not_found") {
    return "データベースが見つかりません。Notion でデータベースの「…」→「コネクト」から、このインテグレーションを追加してください";
  }
  if (status === 403) return "このインテグレーションには権限がありません(読み取り・更新の権限を確認してください)";
  return message || `Notion API エラー (${status})`;
}

export async function notion(method, path, body, { token = loadToken(), retries = 3 } = {}) {
  if (!token) throw new NotionError(401, "no_token", "Notion のトークンが未設定です");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Notion のレート制限は平均 3 req/s。429 と一時的な 5xx は待って再試行する
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 30000)));
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new NotionError(res.status, json.code, friendlyError(res.status, json.code, json.message));
    return json;
  }
}

// ---- URL / ID ----

function dashed(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// データベースの URL (https://www.notion.so/ws/Title-<32hex>?v=...)、32桁/ハイフン付きの ID、
// collection://<uuid> (データソース ID) を受け付ける。
export function parseNotionId(input) {
  const s = String(input || "").trim();
  const collection = s.match(/^collection:\/\/([0-9a-f-]{32,36})$/i);
  if (collection) return { kind: "data_source", id: dashed(collection[1].replace(/-/g, "").toLowerCase()) };
  let path = s;
  try {
    path = new URL(s).pathname;
  } catch {}
  const hits = path.replace(/-/g, "").match(/[0-9a-f]{32}/gi);
  if (!hits) return null;
  return { kind: "database", id: dashed(hits[hits.length - 1].toLowerCase()) };
}

const normId = (id) => String(id || "").replace(/-/g, "").toLowerCase();

// ---- プロパティの読み取り ----

const plain = (rich) => (rich || []).map((r) => r.plain_text ?? r.text?.content ?? "").join("");

function propText(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title": return plain(prop.title);
    case "rich_text": return plain(prop.rich_text);
    case "select": return prop.select?.name || "";
    case "status": return prop.status?.name || "";
    case "multi_select": return prop.multi_select?.[0]?.name || "";
    case "checkbox": return prop.checkbox ? "true" : "false";
    default: return "";
  }
}

const DONE_RE = /(done|complete|完了|済|終了|closed|resolved|archived|アーカイブ)/i;
const DOING_RE = /(doing|progress|進行|作業中|対応中|着手|実行中|in review|レビュー|wip|started)/i;

function guessColumn(name) {
  if (DONE_RE.test(name)) return "done";
  if (DOING_RE.test(name)) return "doing";
  return "todo";
}

// ステータス系プロパティの定義から、Notion のステータス名 ↔ ボードの列 の対応を作る。
// status 型はグループ(To-do / In progress / Complete)で、select 型は名前から推測する。
export function buildStatusMapping(propDef) {
  if (!propDef) return { status_map: {}, writeback: {} };
  if (propDef.type === "checkbox") {
    return { status_map: { true: "done", false: "todo" }, writeback: { todo: "false", doing: "false", done: "true" } };
  }
  const options = (propDef.status?.options || propDef.select?.options || []).map((o) => o.name);
  const status_map = {};
  if (propDef.type === "status" && propDef.status?.groups?.length) {
    const byId = Object.fromEntries((propDef.status.options || []).map((o) => [o.id, o.name]));
    const groups = propDef.status.groups;
    groups.forEach((g, i) => {
      let col = /complete|done|完了/i.test(g.name) ? "done"
        : /progress|進行/i.test(g.name) ? "doing"
        : /to-?do|未着手/i.test(g.name) ? "todo"
        : ["todo", "doing", "done"][Math.min(i, 2)];
      for (const oid of g.option_ids || []) if (byId[oid]) status_map[byId[oid]] = col;
    });
  }
  for (const name of options) if (!status_map[name]) status_map[name] = guessColumn(name);
  const writeback = {};
  for (const col of ["todo", "doing", "done"]) {
    writeback[col] = options.find((n) => status_map[n] === col) || "";
  }
  return { status_map, writeback };
}

function columnFor(source, externalStatus) {
  if (!source.status_prop) return "todo";
  return source.status_map[externalStatus] || guessColumn(externalStatus || "");
}

// ---- データベースの調査(追加ダイアログ用) ----

async function resolveDataSource(input, token) {
  const parsed = parseNotionId(input);
  if (!parsed) throw new Error("Notion データベースの URL か ID を入力してください");
  if (parsed.kind === "data_source") {
    const ds = await notion("GET", `/data_sources/${parsed.id}`, null, { token });
    return { database: null, dataSource: ds };
  }
  let database;
  try {
    database = await notion("GET", `/databases/${parsed.id}`, null, { token });
  } catch (err) {
    // ページの URL(データベースを埋め込んだページ)が貼られたときの案内
    if (err.code === "validation_error" || err.status === 400) {
      throw new Error("これはデータベースではなくページの URL のようです。データベースの「…」→「ビューのリンクをコピー」で取れる URL を貼ってください");
    }
    throw err;
  }
  const first = database.data_sources?.[0];
  if (!first) throw new Error("このデータベースにはデータソースがありません");
  const ds = await notion("GET", `/data_sources/${first.id}`, null, { token });
  return { database, dataSource: ds };
}

// 「自分」の候補。ワークスペースのメンバー一覧(ユーザー情報の権限が必要)を優先し、
// 取れなければデータベースの行に出てくる人から集める。
// 名前が取れない(インテグレーションに「ユーザー情報を読み取る」権限が無い)と、
// Notion は people に ID しか入れない。そのときは named=false で返し、画面で案内する。
// count はデータベース先頭 100 行でその人が担当者に入っている数(誰か見分ける手がかり)。
async function listPeople(dataSourceId, peopleProps, token) {
  const people = await listPeopleRaw(dataSourceId, peopleProps, token);
  try {
    const r = await notion("POST", `/data_sources/${dataSourceId}/query`, { page_size: 100 }, { token });
    const counts = new Map();
    for (const page of r.results || []) {
      for (const name of peopleProps) {
        for (const u of page.properties?.[name]?.people || []) counts.set(u.id, (counts.get(u.id) || 0) + 1);
      }
    }
    for (const p of people) p.count = counts.get(p.id) || 0;
  } catch {}
  return people
    .map((p) => ({ ...p, named: !!(p.name && p.name !== p.id) }))
    .sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.name).localeCompare(String(b.name), "ja"));
}

async function listPeopleRaw(dataSourceId, peopleProps, token) {
  const people = new Map();
  try {
    let cursor;
    do {
      const r = await notion("GET", `/users?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`, null, { token });
      for (const u of r.results || []) {
        if (u.type === "person") people.set(u.id, { id: u.id, name: u.name || u.person?.email || u.id, email: u.person?.email || "" });
      }
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor && people.size < 1000);
  } catch {}
  if (people.size) return [...people.values()];
  const r = await notion("POST", `/data_sources/${dataSourceId}/query`, { page_size: 100 }, { token });
  for (const page of r.results || []) {
    for (const name of peopleProps) {
      for (const u of page.properties?.[name]?.people || []) {
        if (u.object === "user" && u.type !== "bot") people.set(u.id, { id: u.id, name: u.name || u.id, email: u.person?.email || "" });
      }
    }
  }
  return [...people.values()];
}

export async function inspectDatabase(input, opts = {}) {
  const info = await inspectDatabaseRaw(input, opts);
  info.people_named = info.people.some((p) => p.named);
  return info;
}

// 追加ダイアログのプレビュー: この設定で取り込まれる行の件数と、列ごとの内訳・例
export async function previewSource({ url, people_prop, person_id, status_prop }, { token = loadToken() } = {}) {
  const { dataSource } = await resolveDataSource(url, token);
  if (!people_prop || !person_id) return { total: 0, has_more: false, by_column: {}, samples: [] };
  const titleProp = Object.values(dataSource.properties || {}).find((p) => p.type === "title")?.name;
  const statusDef = status_prop ? dataSource.properties?.[status_prop] : null;
  const mapping = buildStatusMapping(statusDef);
  const r = await notion("POST", `/data_sources/${dataSource.id}/query`, {
    filter: { property: people_prop, people: { contains: person_id } },
    page_size: 100,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  }, { token });
  const by_column = { todo: 0, doing: 0, done: 0 };
  const samples = [];
  for (const page of r.results || []) {
    if (page.archived || page.in_trash) continue;
    const ext = statusDef ? propText(page.properties?.[status_prop]) : "";
    const col = statusDef ? mapping.status_map[ext] || guessColumn(ext) : "todo";
    by_column[col]++;
    if (samples.length < 3) samples.push({ title: propText(page.properties?.[titleProp]) || "(無題)", status: ext });
  }
  return { total: by_column.todo + by_column.doing + by_column.done, has_more: !!r.has_more, by_column, samples };
}

async function inspectDatabaseRaw(input, { token = loadToken() } = {}) {
  const { database, dataSource } = await resolveDataSource(input, token);
  const props = Object.values(dataSource.properties || {});
  const byType = (...types) => props.filter((p) => types.includes(p.type)).map((p) => p.name);
  const titleProp = props.find((p) => p.type === "title")?.name;
  const peopleProps = byType("people");
  const statusProps = byType("status", "select", "checkbox");
  const projectProps = byType("select", "multi_select", "relation", "rich_text");
  const statusDefs = Object.fromEntries(
    props.filter((p) => ["status", "select", "checkbox"].includes(p.type)).map((p) => [
      p.name,
      { type: p.type, options: (p.status?.options || p.select?.options || []).map((o) => o.name), ...buildStatusMapping(p) },
    ])
  );
  const title = plain(database?.title) || plain(dataSource.title) || "Notion";
  return {
    database_id: database?.id || dataSource.parent?.database_id || dataSource.database_parent?.database_id || "",
    data_source_id: dataSource.id,
    title,
    url: database?.url || dataSource.url || "",
    title_prop: titleProp,
    people_props: peopleProps,
    status_props: statusProps,
    status_defs: statusDefs,
    project_props: projectProps,
    people: await listPeople(dataSource.id, peopleProps, token),
    // 推奨の初期値: 担当者っぽい名前の people プロパティ / status 型を優先
    suggested: {
      people_prop: peopleProps.find((n) => /担当|assignee|owner|assign/i.test(n)) || peopleProps[0] || "",
      status_prop: byType("status")[0] || statusProps.find((n) => /status|ステータス|状態/i.test(n)) || "",
      project_prop: projectProps.find((n) => /project|プロジェクト|案件/i.test(n)) || "",
    },
  };
}

// ---- 同期 ----

// リレーション先のタイトル。DB にキャッシュして 1 日ごとに取り直す。
// インテグレーションに共有されていないページは読めないので空文字になる
const TITLE_TTL_MS = 24 * 60 * 60 * 1000;

async function relationInfo(pageId, token) {
  const cached = getCachedTitle(pageId, TITLE_TTL_MS);
  if (cached) return { title: cached.title, url: cached.url };
  let title = "";
  let url = null;
  try {
    const page = await notion("GET", `/pages/${pageId}`, null, { token });
    const tp = Object.values(page.properties || {}).find((p) => p.type === "title");
    title = plain(tp?.title);
    url = page.url || null;
  } catch {}
  setCachedTitle(pageId, title, url);
  return { title, url };
}

async function relationTitle(pageId, token) {
  return (await relationInfo(pageId, token)).title;
}

// ---- プロパティの表示用整形 ----

// 日付は YYYY/MM/DD(時刻付きなら HH:mm も)
function fmtDate(iso) {
  if (!iso) return "";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return String(iso);
  return `${m[1]}/${m[2]}/${m[3]}${m[4] ? ` ${m[4]}:${m[5]}` : ""}`;
}

function fmtDateRange(d) {
  if (!d?.start) return "";
  return d.end ? `${fmtDate(d.start)} → ${fmtDate(d.end)}` : fmtDate(d.start);
}

function fmtPerson(u, source) {
  if (!u) return "";
  if (u.name) return u.name;
  // 名前が取れない(ユーザー情報の権限なし)ときは、自分だけ分かるようにする
  if (source && normId(u.id) === normId(source.person_id)) return "あなた";
  return `メンバー（${String(u.id).slice(0, 8)}）`;
}

function fmtNumber(n) {
  if (n === null || n === undefined) return "";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// 1 つのプロパティを { name, type, text, items? } にする。items はリレーション先のリンク
export async function formatProp(name, prop, { source, token } = {}) {
  const out = { name, type: prop?.type || "", text: "" };
  if (!prop) return out;
  switch (prop.type) {
    case "rich_text": out.text = plain(prop.rich_text); break;
    case "number": out.text = fmtNumber(prop.number); break;
    case "select": out.text = prop.select?.name || ""; break;
    case "status": out.text = prop.status?.name || ""; break;
    case "multi_select": out.text = (prop.multi_select || []).map((o) => o.name).join("、"); break;
    case "date": out.text = fmtDateRange(prop.date); break;
    case "people": out.text = (prop.people || []).map((u) => fmtPerson(u, source)).join("、"); break;
    case "checkbox": out.text = prop.checkbox ? "✓" : ""; break;
    case "url": out.text = prop.url || ""; break;
    case "email": out.text = prop.email || ""; break;
    case "phone_number": out.text = prop.phone_number || ""; break;
    case "files": out.text = (prop.files || []).map((f) => f.name).join("、"); break;
    case "created_time": out.text = fmtDate(prop.created_time); break;
    case "last_edited_time": out.text = fmtDate(prop.last_edited_time); break;
    case "created_by": out.text = fmtPerson(prop.created_by, source); break;
    case "last_edited_by": out.text = fmtPerson(prop.last_edited_by, source); break;
    case "unique_id": out.text = prop.unique_id?.number != null ? `${prop.unique_id.prefix ? `${prop.unique_id.prefix}-` : ""}${prop.unique_id.number}` : ""; break;
    case "verification": out.text = prop.verification?.state === "verified" ? "確認済み" : ""; break;
    case "formula": {
      const f = prop.formula || {};
      out.text = f.type === "string" ? f.string || ""
        : f.type === "number" ? fmtNumber(f.number)
        : f.type === "boolean" ? (f.boolean ? "✓" : "")
        : f.type === "date" ? fmtDateRange(f.date) : "";
      break;
    }
    case "rollup": {
      const r = prop.rollup || {};
      if (r.type === "number") out.text = fmtNumber(r.number);
      else if (r.type === "date") out.text = fmtDateRange(r.date);
      else if (r.type === "array") {
        const parts = [];
        for (const item of r.array || []) {
          const t = (await formatProp(name, item, { source, token })).text;
          if (t) parts.push(t);
        }
        out.text = parts.join("、");
      }
      break;
    }
    case "relation": {
      const items = [];
      for (const rel of (prop.relation || []).slice(0, 20)) {
        const info = await relationInfo(normId(rel.id), token);
        items.push({ title: info.title || "（共有されていないページ）", url: info.url || `https://www.notion.so/${normId(rel.id)}` });
      }
      out.items = items;
      out.text = items.map((i) => i.title).join("、");
      break;
    }
    default: break;
  }
  return out;
}

// タイトル以外の全プロパティを、データソースの定義順で整形する
async function formatProps(page, source, token) {
  const out = [];
  for (const [name, prop] of Object.entries(page.properties || {})) {
    if (prop?.type === "title" || prop?.type === "button") continue;
    out.push(await formatProp(name, prop, { source, token }));
  }
  return out;
}

async function projectFor(source, page, token) {
  return resolveProjectAlias(await originalProjectFor(source, page, token));
}

async function originalProjectFor(source, page, token) {
  if (source.project_prop) {
    const prop = page.properties?.[source.project_prop];
    if (prop?.type === "relation") {
      const rel = prop.relation?.[0]?.id;
      if (rel) {
        const t = await relationTitle(rel, token);
        if (t) return t;
      }
    } else {
      const t = propText(prop).trim();
      if (t) return t;
    }
  }
  return source.title || "Notion";
}

function externalStatusOf(source, page) {
  if (!source.status_prop) return null;
  return propText(page.properties?.[source.status_prop]) || null;
}

async function queryAll(source, extraFilter, token) {
  const base = { property: source.people_prop, people: { contains: source.person_id } };
  const filter = extraFilter ? { and: [base, extraFilter] } : base;
  const pages = [];
  let cursor;
  do {
    const body = { filter, page_size: 100, sorts: [{ timestamp: "last_edited_time", direction: "descending" }] };
    if (cursor) body.start_cursor = cursor;
    const r = await notion("POST", `/data_sources/${source.data_source_id}/query`, body, { token });
    pages.push(...(r.results || []));
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && pages.length < MAX_PAGES);
  return pages;
}

// 1つの同期元を同期する。full=false なら前回同期以降に更新された行だけ取る。
// full=true のときは、担当から外れた・削除された・古い完了の行をボードから消す。
export async function syncSource(sourceOrId, { full = false, token = loadToken(), isRunning = () => false } = {}) {
  const source = typeof sourceOrId === "object" ? sourceOrId : getNotionSource(sourceOrId);
  if (!source) throw new Error("同期元が見つかりません");
  const doFull = full || !source.last_full_sync_at;
  try {
    let since = null;
    if (!doFull && source.last_synced_at) {
      // Notion の last_edited_time は分単位に丸められるので少し戻して取り直す
      since = new Date(new Date(source.last_synced_at).getTime() - 2 * 60 * 1000).toISOString();
    }
    const pages = await queryAll(
      source,
      since ? { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } } : null,
      token
    );
    const cutoff = Date.now() - DONE_KEEP_DAYS * 86400000;
    const seen = new Set();
    let changed = 0;
    for (const page of pages) {
      if (page.archived || page.in_trash) continue;
      const externalStatus = externalStatusOf(source, page);
      const status = columnFor(source, externalStatus);
      if (status === "done" && new Date(page.last_edited_time).getTime() < cutoff) continue;
      seen.add(normId(page.id));
      // 本文はページが更新されたときだけ取り直す(1 ページ 1 リクエスト以上かかるため)
      const existing = getTaskByNotionPage(normId(page.id));
      let body;
      if (!existing || existing.notion_edited_at !== page.last_edited_time || existing.notion_body == null) {
        try { body = await fetchPageText(page.id, { token }); } catch { body = undefined; }
      }
      const r = upsertNotionTask({
        pageId: normId(page.id),
        url: page.url,
        sourceId: source.id,
        title: propText(page.properties?.[source.title_prop]).trim(),
        status,
        externalStatus,
        project: await projectFor(source, page, token),
        props: await formatProps(page, source, token),
        body,
        editedAt: page.last_edited_time,
      });
      if (r.changed) changed++;
    }
    if (doFull) {
      for (const row of listNotionTaskIds(source.id)) {
        if (!seen.has(row.notion_page_id) && !isRunning(row.id)) {
          deleteTask(row.id);
          changed++;
        }
      }
    } else {
      // 差分同期ではゴミ箱行・担当外れは拾えないので、ゴミ箱入りだけはここで消す
      for (const page of pages) {
        if (page.archived || page.in_trash) {
          const t = listNotionTaskIds(source.id).find((r) => r.notion_page_id === normId(page.id));
          if (t && !isRunning(t.id)) { deleteTask(t.id); changed++; }
        }
      }
    }
    markNotionSourceSynced(source.id, { full: doFull });
    return { changed, fetched: pages.length, full: doFull };
  } catch (err) {
    markNotionSourceSynced(source.id, { error: err.message });
    throw err;
  }
}

const FULL_SYNC_MS = 10 * 60 * 1000;

export async function syncAll({ force = false, isRunning } = {}) {
  if (!loadToken()) return { changed: 0 };
  let changed = 0;
  for (const source of listNotionSources()) {
    const full = force || !source.last_full_sync_at ||
      Date.now() - new Date(source.last_full_sync_at).getTime() > FULL_SYNC_MS;
    try {
      changed += (await syncSource(source, { full, isRunning })).changed;
    } catch (err) {
      console.error(`Notion 同期に失敗 (${source.title}): ${err.message}`);
    }
  }
  return { changed };
}

// ---- 書き戻し ----

function statusPropertyValue(source, name) {
  if (source.status_type === "status") return { status: { name } };
  if (source.status_type === "select") return { select: { name } };
  if (source.status_type === "checkbox") return { checkbox: name === "true" };
  return null;
}

// タスクの更新。Notion ミラーなら先に Notion に書き戻し、成功したらローカルを更新する
// (Notion が失敗したらローカルも変えずにエラーにする。次の同期で巻き戻るのを防ぐため)。
export async function updateTaskSynced(id, fields, { token = loadToken() } = {}) {
  const task = getTask(id);
  if (!task) throw new Error(`task ${id} not found`);
  if (!task.notion_page_id) return updateTask(id, fields);
  const source = getNotionSource(task.notion_source_id);
  const local = { ...fields };
  // グループは Notion のプロパティから決まるのでローカルでは変えない
  delete local.project;
  const props = {};
  if (source && fields.title !== undefined && fields.title.trim() && fields.title !== task.title) {
    props[source.title_prop] = { title: [{ type: "text", text: { content: fields.title.trim() } }] };
  }
  let newExternal;
  if (source?.status_prop && fields.status && fields.status !== task.status) {
    const current = task.external_status;
    // 今の Notion ステータスがすでにその列に属していれば書き換えない (例: 「レビュー中」も Doing)
    if (!(current && source.status_map[current] === fields.status)) {
      const target = source.writeback[fields.status];
      if (target) {
        const value = statusPropertyValue(source, target);
        if (value) {
          props[source.status_prop] = value;
          newExternal = target;
        }
      }
    }
  }
  if (Object.keys(props).length) {
    await notion("PATCH", `/pages/${task.notion_page_id}`, { properties: props }, { token });
    if (newExternal !== undefined) setExternalStatus(id, newExternal);
  }
  return updateTask(id, local);
}

// 依頼プロンプト用: ページ本文をテキストで取る(先頭 100 ブロック・入れ子は 1 段まで)
export async function fetchPageText(pageId, { token = loadToken(), maxChars = 6000 } = {}) {
  const lines = [];
  async function walk(blockId, depth) {
    const r = await notion("GET", `/blocks/${blockId}/children?page_size=100`, null, { token });
    for (const b of r.results || []) {
      const body = b[b.type];
      const text = plain(body?.rich_text);
      const prefix = {
        heading_1: "# ", heading_2: "## ", heading_3: "### ",
        bulleted_list_item: "- ", numbered_list_item: "1. ", to_do: body?.checked ? "- [x] " : "- [ ] ",
        quote: "> ", callout: "> ", toggle: "▸ ",
      }[b.type] || "";
      if (text) lines.push("  ".repeat(depth) + prefix + text);
      if (b.has_children && depth < 1 && lines.join("\n").length < maxChars) await walk(b.id, depth + 1);
    }
  }
  await walk(pageId, 0);
  return lines.join("\n").slice(0, maxChars);
}
