import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.TASKDECK_DIR || join(homedir(), ".taskdeck");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "tasks.db"));
db.pragma("journal_mode = WAL");

const schema = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT 'inbox',
    session TEXT,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
    position REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    done_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  // タスクが1件も無いグループもサーバー側で共有するための登録簿。
  // タスク付きのグループは tasks から導出されるため、ここには載らないこともある。
  `CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];
for (const stmt of schema) db.prepare(stmt).run();

const columns = db.prepare("PRAGMA table_info(tasks)").all();
if (!columns.some((c) => c.name === "priority")) {
  db.prepare("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT ''").run();
}
if (!columns.some((c) => c.name === "origin_path")) {
  // タスク登録元の作業ディレクトリ(Claudeセッションの --resume 実行に使う)
  db.prepare("ALTER TABLE tasks ADD COLUMN origin_path TEXT").run();
}
// Notion データベースから同期したタスク(ミラー)の対応付け。
// notion_page_id があるタスクは Notion が正本で、タイトルとステータスは Notion に書き戻す。
// external_status は Notion 側のステータス名そのもの(カードに表示する)。
for (const [name, type] of [
  ["notion_page_id", "TEXT"],
  ["notion_url", "TEXT"],
  ["notion_source_id", "INTEGER"],
  ["external_status", "TEXT"],
  // Notion のプロパティ(タイトル以外)を表示用に整形したもの: [{ name, type, text, items? }] の JSON
  ["notion_props", "TEXT"],
  // Notion ページ本文のテキスト(Markdown 風)と、それを取った時点のページ更新時刻
  ["notion_body", "TEXT"],
  ["notion_edited_at", "TEXT"],
]) {
  if (!columns.some((c) => c.name === name)) {
    db.prepare(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`).run();
  }
}
db.prepare(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_notion_page ON tasks(notion_page_id) WHERE notion_page_id IS NOT NULL"
).run();

const extraSchema = [
  // 同期元の Notion データベース。filter は「people_prop に person_id が入っている行」。
  // status_map: Notion のステータス名 → todo/doing/done、writeback: todo/doing/done → 書き戻すステータス名
  `CREATE TABLE IF NOT EXISTS notion_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    database_id TEXT NOT NULL,
    data_source_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    title_prop TEXT NOT NULL,
    people_prop TEXT NOT NULL,
    person_id TEXT NOT NULL,
    person_name TEXT NOT NULL DEFAULT '',
    status_prop TEXT,
    status_type TEXT,
    status_map TEXT NOT NULL DEFAULT '{}',
    writeback TEXT NOT NULL DEFAULT '{}',
    project_prop TEXT,
    display_props TEXT,
    last_synced_at TEXT,
    last_full_sync_at TEXT,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // タスクと AI セッション(Claude Code / Codex)の紐付け。
  // via: mcp(AI が着手を通知) / dispatch(🤖 ボタンで起動) / scan(会話ログのスキャンで発見)
  `CREATE TABLE IF NOT EXISTS task_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    cwd TEXT,
    title TEXT NOT NULL DEFAULT '',
    transcript_path TEXT,
    via TEXT NOT NULL DEFAULT 'scan',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (task_id, agent, session_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_sessions_task ON task_sessions(task_id)`,
];
for (const stmt of extraSchema) db.prepare(stmt).run();
// 既存の notion_sources に後から足した列
const sourceCols = db.prepare("PRAGMA table_info(notion_sources)").all();
if (!sourceCols.some((c) => c.name === "display_props")) {
  // 表示するプロパティと順番: [{ name, card }] の JSON。NULL ならおまかせ(画面側の既定)
  db.prepare("ALTER TABLE notion_sources ADD COLUMN display_props TEXT").run();
}
// グループ名の付け替え。Notion から来るグループ名(DB 名やプロパティの値)は同期のたびに
// 元に戻るので、「元の名前 → 表示する名前」を覚えておき同期時に付け替える
db.prepare(
  `CREATE TABLE IF NOT EXISTS project_aliases (
    original TEXT PRIMARY KEY,
    alias TEXT NOT NULL
  )`
).run();
// リレーション先ページのタイトルのキャッシュ
db.prepare(
  `CREATE TABLE IF NOT EXISTS notion_titles (
    page_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`
).run();

const VALID_STATUS = new Set(["todo", "doing", "done"]);
const VALID_PRIORITY = new Set(["", "high", "medium", "low"]);

function nextPosition(project, status) {
  const row = db
    .prepare("SELECT MAX(position) AS p FROM tasks WHERE project = ? AND status = ?")
    .get(project, status);
  return (row?.p ?? 0) + 1024;
}

export function addTask({ title, notes = "", project = "inbox", session = null, status = "todo", priority = "", origin_path = null }) {
  if (!title || !title.trim()) throw new Error("title is required");
  if (!VALID_STATUS.has(status)) throw new Error(`invalid status: ${status}`);
  if (!VALID_PRIORITY.has(priority)) throw new Error(`invalid priority: ${priority}`);
  project = project.trim() || "inbox";
  const info = db
    .prepare(
      `INSERT INTO tasks (title, notes, project, session, status, position, priority, origin_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(title.trim(), notes, project, session, status, nextPosition(project, status), priority, origin_path);
  return getTask(info.lastInsertRowid);
}

export function getTask(id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

export function listTasks({ project, status, session, includeDone = true } = {}) {
  const cond = [];
  const args = [];
  if (project) { cond.push("project = ?"); args.push(project); }
  if (status) { cond.push("status = ?"); args.push(status); }
  if (session) { cond.push("session = ?"); args.push(session); }
  if (!includeDone && !status) cond.push("status != 'done'");
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY status, position, id`)
    .all(...args);
}

export function updateTask(id, fields) {
  const task = getTask(id);
  if (!task) throw new Error(`task ${id} not found`);
  const allowed = ["title", "notes", "project", "session", "status", "position", "priority", "origin_path"];
  const sets = [];
  const args = [];
  for (const key of allowed) {
    if (fields[key] === undefined) continue;
    if (key === "status" && !VALID_STATUS.has(fields.status)) {
      throw new Error(`invalid status: ${fields.status}`);
    }
    if (key === "priority" && !VALID_PRIORITY.has(fields.priority)) {
      throw new Error(`invalid priority: ${fields.priority}`);
    }
    sets.push(`${key} = ?`);
    args.push(fields[key]);
  }
  if (!sets.length) return task;
  if (fields.status && fields.status !== task.status && fields.position === undefined) {
    sets.push("position = ?");
    args.push(nextPosition(fields.project ?? task.project, fields.status));
  }
  sets.push("updated_at = datetime('now')");
  if (fields.status === "done") {
    sets.push("done_at = COALESCE(done_at, datetime('now'))");
  } else if (fields.status) {
    sets.push("done_at = NULL");
  }
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return getTask(id);
}

export function deleteTask(id) {
  const info = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  db.prepare("DELETE FROM task_sessions WHERE task_id = ?").run(id);
  return info.changes > 0;
}

// ---- Notion ミラー ----

export function getTaskByNotionPage(pageId) {
  return db.prepare("SELECT * FROM tasks WHERE notion_page_id = ?").get(pageId);
}

// Notion から取ってきた行をボードに反映する。メモ・優先度・登録元セッションはローカルの
// ものを残し、Notion が正本の項目(タイトル・ステータス・グループ・URL)だけ上書きする。
export function upsertNotionTask({
  pageId, url, sourceId, title, status, externalStatus, project,
  props = null, body = undefined, editedAt = null,
}) {
  const existing = getTaskByNotionPage(pageId);
  const propsJson = props ? JSON.stringify(props) : null;
  if (!existing) {
    project = (project || "").trim() || "inbox";
    const info = db
      .prepare(
        `INSERT INTO tasks (title, project, status, position, notion_page_id, notion_url, notion_source_id, external_status,
                            notion_props, notion_body, notion_edited_at, done_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') END)`
      )
      .run(title || "(無題)", project, status, nextPosition(project, status), pageId, url, sourceId, externalStatus,
        propsJson, body ?? null, editedAt, status);
    return { task: getTask(info.lastInsertRowid), changed: true };
  }
  const fields = {};
  if ((title || "(無題)") !== existing.title) fields.title = title || "(無題)";
  if (status !== existing.status) fields.status = status;
  if (project && project !== existing.project) fields.project = project;
  // body が undefined のときは本文を取り直していない(ページが更新されていない)ので触らない
  const nextBody = body === undefined ? existing.notion_body : body;
  const nextProps = propsJson ?? existing.notion_props;
  const metaChanged =
    existing.notion_url !== url ||
    existing.notion_source_id !== sourceId ||
    (existing.external_status ?? null) !== (externalStatus ?? null) ||
    (existing.notion_props ?? null) !== (nextProps ?? null) ||
    (existing.notion_body ?? null) !== (nextBody ?? null) ||
    (editedAt && existing.notion_edited_at !== editedAt);
  if (metaChanged) {
    db.prepare(
      `UPDATE tasks SET notion_url = ?, notion_source_id = ?, external_status = ?, notion_props = ?, notion_body = ?,
         notion_edited_at = COALESCE(?, notion_edited_at) WHERE id = ?`
    ).run(url, sourceId, externalStatus, nextProps, nextBody, editedAt, existing.id);
  }
  if (Object.keys(fields).length) return { task: updateTask(existing.id, fields), changed: true };
  return { task: metaChanged ? getTask(existing.id) : existing, changed: metaChanged };
}

export function setExternalStatus(id, externalStatus) {
  db.prepare("UPDATE tasks SET external_status = ? WHERE id = ?").run(externalStatus, id);
}

export function listNotionTaskIds(sourceId) {
  return db.prepare("SELECT id, notion_page_id FROM tasks WHERE notion_source_id = ?").all(sourceId);
}

const SOURCE_JSON = ["status_map", "writeback"];
function parseSource(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of SOURCE_JSON) {
    try { out[k] = JSON.parse(row[k] || "{}"); } catch { out[k] = {}; }
  }
  try { out.display_props = row.display_props ? JSON.parse(row.display_props) : null; } catch { out.display_props = null; }
  return out;
}

// 表示するプロパティと順番を保存する。null で「おまかせ」に戻す
export function setNotionDisplayProps(id, displayProps) {
  db.prepare("UPDATE notion_sources SET display_props = ? WHERE id = ?")
    .run(displayProps ? JSON.stringify(displayProps) : null, id);
  return getNotionSource(id);
}

export function getCachedTitle(pageId, maxAgeMs) {
  const row = db.prepare("SELECT * FROM notion_titles WHERE page_id = ?").get(pageId);
  if (!row) return null;
  const age = Date.now() - Date.parse(row.fetched_at.replace(" ", "T") + "Z");
  return age < maxAgeMs ? row : null;
}

export function setCachedTitle(pageId, title, url) {
  db.prepare(
    `INSERT INTO notion_titles (page_id, title, url, fetched_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (page_id) DO UPDATE SET title = excluded.title, url = excluded.url, fetched_at = excluded.fetched_at`
  ).run(pageId, title, url);
}

export function listNotionSources() {
  return db.prepare("SELECT * FROM notion_sources ORDER BY id").all().map(parseSource);
}

export function getNotionSource(id) {
  return parseSource(db.prepare("SELECT * FROM notion_sources WHERE id = ?").get(id));
}

export function saveNotionSource(src) {
  const cols = [
    "database_id", "data_source_id", "title", "url", "title_prop", "people_prop", "person_id",
    "person_name", "status_prop", "status_type", "status_map", "writeback", "project_prop",
  ];
  const vals = cols.map((c) => (SOURCE_JSON.includes(c) ? JSON.stringify(src[c] || {}) : src[c] ?? null));
  const existing = db.prepare("SELECT id FROM notion_sources WHERE data_source_id = ?").get(src.data_source_id);
  if (existing) {
    db.prepare(
      `UPDATE notion_sources SET ${cols.map((c) => `${c} = ?`).join(", ")},
         last_synced_at = NULL, last_full_sync_at = NULL, last_error = '' WHERE id = ?`
    ).run(...vals, existing.id);
    return getNotionSource(existing.id);
  }
  const info = db
    .prepare(`INSERT INTO notion_sources (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...vals);
  return getNotionSource(info.lastInsertRowid);
}

export function markNotionSourceSynced(id, { full = false, error = "" } = {}) {
  if (error) {
    db.prepare("UPDATE notion_sources SET last_error = ? WHERE id = ?").run(error, id);
    return;
  }
  db.prepare(
    `UPDATE notion_sources SET last_error = '', last_synced_at = ?
       ${full ? ", last_full_sync_at = ?" : ""} WHERE id = ?`
  ).run(...(full ? [new Date().toISOString(), new Date().toISOString(), id] : [new Date().toISOString(), id]));
}

// 同期元の登録解除。ミラーしていたタスクもボードから消す(Notion 側のページは消さない)
export function deleteNotionSource(id) {
  const ids = listNotionTaskIds(id).map((r) => r.id);
  for (const taskId of ids) deleteTask(taskId);
  return db.prepare("DELETE FROM notion_sources WHERE id = ?").run(id).changes > 0;
}

// ---- AI セッションの紐付け ----

export function recordTaskSession({ taskId, agent, sessionId, cwd = null, title = "", transcriptPath = null, via = "scan", seenAt = null }) {
  if (!getTask(taskId) || !agent || !sessionId) return null;
  const seen = seenAt || new Date().toISOString();
  db.prepare(
    `INSERT INTO task_sessions (task_id, agent, session_id, cwd, title, transcript_path, via, started_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, agent, session_id) DO UPDATE SET
       cwd = COALESCE(excluded.cwd, cwd),
       title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END,
       transcript_path = COALESCE(excluded.transcript_path, transcript_path),
       last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`
  ).run(taskId, agent, sessionId, cwd, title, transcriptPath, via, seen, seen);
  return db
    .prepare("SELECT * FROM task_sessions WHERE task_id = ? AND agent = ? AND session_id = ?")
    .get(taskId, agent, sessionId);
}

export function listTaskSessions(taskId) {
  const sql = "SELECT * FROM task_sessions" + (taskId ? " WHERE task_id = ?" : "") + " ORDER BY last_seen_at DESC";
  return taskId ? db.prepare(sql).all(taskId) : db.prepare(sql).all();
}

export function normalizeProjectName(name) {
  const project = String(name ?? "").trim().replace(/^#/, "");
  if (!project) throw new Error("project name is required");
  return project;
}

// 登録済みの空グループも 0 件として返すため、tasks からの集計と UNION する
export function listProjects() {
  return db
    .prepare(
      `SELECT project, SUM(total) AS total, SUM(open) AS open FROM (
         SELECT project, COUNT(*) AS total, SUM(status != 'done') AS open
           FROM tasks GROUP BY project
         UNION ALL
         SELECT name AS project, 0 AS total, 0 AS open FROM projects
       ) GROUP BY project ORDER BY project`
    )
    .all();
}

export function addProject(name) {
  const project = normalizeProjectName(name);
  db.prepare("INSERT OR IGNORE INTO projects (name) VALUES (?)").run(project);
  return listProjects().find((p) => p.project === project) ?? { project, total: 0, open: 0 };
}

// 空グループの登録解除。タスクが残っている場合は消さない(タスクの巻き添え防止)
export function deleteProject(name) {
  const project = normalizeProjectName(name);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project = ?").get(project);
  if (n > 0) throw new Error(`グループ「${project}」にはタスクが ${n} 件残っています`);
  return db.prepare("DELETE FROM projects WHERE name = ?").run(project).changes > 0;
}

export function resolveProjectAlias(name) {
  const row = db.prepare("SELECT alias FROM project_aliases WHERE original = ?").get(name);
  return row ? row.alias : name;
}

// グループ名を変える。変更先が既にあれば、そのグループにまとめる(タスクは消えない)。
// Notion のタスクを含むグループは、次の同期でも新しい名前になるよう付け替えを記録する
export const renameProject = db.transaction((from, to) => {
  from = normalizeProjectName(from);
  to = normalizeProjectName(to);
  if (from === to) return { from, to, moved: 0 };
  const moved = db.prepare(
    "UPDATE tasks SET project = ?, updated_at = datetime('now') WHERE project = ?"
  ).run(to, from).changes;
  if (db.prepare("SELECT 1 FROM projects WHERE name = ?").get(from)) {
    db.prepare("DELETE FROM projects WHERE name = ?").run(from);
    db.prepare("INSERT OR IGNORE INTO projects (name) VALUES (?)").run(to);
  }
  // 以前「X → from」と付け替えていたものは「X → to」に、from そのものも「from → to」に
  db.prepare("UPDATE project_aliases SET alias = ? WHERE alias = ?").run(to, from);
  db.prepare(
    `INSERT INTO project_aliases (original, alias) VALUES (?, ?)
     ON CONFLICT (original) DO UPDATE SET alias = excluded.alias`
  ).run(from, to);
  // 元の名前に戻したときは付け替え不要
  db.prepare("DELETE FROM project_aliases WHERE original = alias").run();
  return { from, to, moved };
});

// グループをタスクごと削除する。Notion のタスクは Notion が正本なので残す(消しても次の同期で戻る)。
// skip(taskId) が true のタスク(実行中など)も残す
export function deleteProjectWithTasks(name, { skip = () => false } = {}) {
  const project = normalizeProjectName(name);
  const rows = db.prepare("SELECT id, notion_page_id FROM tasks WHERE project = ?").all(project);
  let deleted = 0;
  let kept = 0;
  for (const r of rows) {
    if (r.notion_page_id || skip(r.id)) { kept++; continue; }
    deleteTask(r.id);
    deleted++;
  }
  if (!kept) db.prepare("DELETE FROM projects WHERE name = ?").run(project);
  return { project, deleted, kept };
}

export function dataVersion() {
  return db.pragma("data_version", { simple: true });
}
