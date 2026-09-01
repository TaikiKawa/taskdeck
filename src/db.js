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
];
for (const stmt of schema) db.prepare(stmt).run();

const VALID_STATUS = new Set(["todo", "doing", "done"]);

function nextPosition(project, status) {
  const row = db
    .prepare("SELECT MAX(position) AS p FROM tasks WHERE project = ? AND status = ?")
    .get(project, status);
  return (row?.p ?? 0) + 1024;
}

export function addTask({ title, notes = "", project = "inbox", session = null, status = "todo" }) {
  if (!title || !title.trim()) throw new Error("title is required");
  if (!VALID_STATUS.has(status)) throw new Error(`invalid status: ${status}`);
  project = project.trim() || "inbox";
  const info = db
    .prepare(
      `INSERT INTO tasks (title, notes, project, session, status, position)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(title.trim(), notes, project, session, status, nextPosition(project, status));
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
  const allowed = ["title", "notes", "project", "session", "status", "position"];
  const sets = [];
  const args = [];
  for (const key of allowed) {
    if (fields[key] === undefined) continue;
    if (key === "status" && !VALID_STATUS.has(fields.status)) {
      throw new Error(`invalid status: ${fields.status}`);
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
  return info.changes > 0;
}

export function listProjects() {
  return db
    .prepare(
      `SELECT project,
              COUNT(*) AS total,
              SUM(status != 'done') AS open
       FROM tasks GROUP BY project ORDER BY project`
    )
    .all();
}

export function dataVersion() {
  return db.pragma("data_version", { simple: true });
}
