// AI セッション(Claude Code / Codex)とタスクの紐付け。
// 各ハーネスが手元に残す会話ログ(JSONL)を読み、タスクに触れたセッションを見つける:
//   - taskdeck MCP の task_start / task_update / task_done を呼んだ (引数の id)
//   - 人間(または 🤖 依頼)のプロンプトに「taskdeck ID: 12」「#12 のタスク」「タスク #12」がある
//   - プロンプトに同期中の Notion ページの URL / ID がある
// ツールの実行結果(task_list の出力など)は読まない。全タスクが並ぶので誤って紐付くため。
// 会話ログの更新時刻が新しいセッションは「作業中」とみなす。
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { db, getTask, recordTaskSession } from "./db.js";

const CLAUDE_PROJECTS = process.env.TASKDECK_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");
const CODEX_SESSIONS = process.env.TASKDECK_CODEX_SESSIONS ||
  join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
// 会話ログがこの時間内に更新されていれば「作業中」
export const ACTIVE_MS = 10 * 60 * 1000;
// 起動時に遡ってスキャンする範囲
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

// ---- 会話ログの場所 ----

export function claudeTranscriptPath(cwd, sessionId) {
  return join(CLAUDE_PROJECTS, String(cwd).replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

function listClaudeFiles(since) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(CLAUDE_PROJECTS); } catch { return out; }
  for (const d of dirs) {
    const dir = join(CLAUDE_PROJECTS, d);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (st.isFile() && st.mtimeMs >= since) out.push({ path: p, agent: "claude", size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

// Codex は sessions/YYYY/MM/DD/rollout-*.jsonl。日付ディレクトリを直近数日ぶん見る
function listCodexFiles(since) {
  const out = [];
  const pad = (n) => String(n).padStart(2, "0");
  for (let i = 0; i < 4; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const dir = join(CODEX_SESSIONS, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs >= since) out.push({ path: p, agent: "codex", size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

// ---- 1行ごとの解析 ----

const TOOL_RE = /taskdeck.*task_(start|update|done)$|^task_(start|update|done)$/;
const ID_PATTERNS = [
  /taskdeck ID:\s*(\d+)/g,
  /(?:taskdeck|タスク)\s*#(\d+)/g,
  /#(\d+)\s*(?:の|番の)?タスク/g,
];

function idsFromToolInput(input) {
  if (!input || typeof input !== "object") return [];
  const ids = [];
  if (Number.isInteger(input.id)) ids.push(input.id);
  if (Array.isArray(input.ids)) ids.push(...input.ids.filter(Number.isInteger));
  return ids;
}

function idsFromText(text, notionIndex) {
  const ids = new Set();
  if (!text) return ids;
  for (const re of ID_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) ids.add(Number(m[1]));
  }
  if (notionIndex.size) {
    for (const m of text.replace(/-/g, "").matchAll(/[0-9a-f]{32}/gi)) {
      const id = notionIndex.get(m[0].toLowerCase());
      if (id) ids.add(id);
    }
  }
  return ids;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && (c.type === "text" || c.type === "input_text"))
    .map((c) => c.text || "")
    .join("\n");
}

// Claude Code の 1 行。{ sessionId, cwd, ids, title, prompt } を返す
function parseClaudeLine(obj, notionIndex) {
  const out = { sessionId: obj.sessionId, cwd: obj.cwd, ids: new Set(), title: "" };
  if (obj.type === "custom-title" && obj.customTitle) out.title = obj.customTitle;
  if (obj.type === "summary" && obj.summary) out.title = obj.summary;
  if (obj.isSidechain) return out;
  if (obj.type === "user" && obj.message?.role === "user") {
    // tool_result はツールの出力なので読まない
    const content = obj.message.content;
    const isToolResult = Array.isArray(content) && content.some((c) => c?.type === "tool_result");
    if (!isToolResult && !obj.isMeta) {
      const text = textOf(content);
      out.prompt = text;
      for (const id of idsFromText(text, notionIndex)) out.ids.add(id);
    }
  }
  if (obj.type === "assistant") {
    for (const c of obj.message?.content || []) {
      if (c?.type === "tool_use" && TOOL_RE.test(c.name || "")) {
        for (const id of idsFromToolInput(c.input)) out.ids.add(id);
      }
    }
  }
  return out;
}

// Codex の 1 行
function parseCodexLine(obj, notionIndex) {
  const out = { ids: new Set(), title: "" };
  const p = obj.payload || {};
  if (obj.type === "session_meta") {
    out.sessionId = p.id || p.session_id;
    out.cwd = p.cwd;
    return out;
  }
  if (obj.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
    const name = [p.namespace, p.name].filter(Boolean).join("__");
    if (TOOL_RE.test(name) || TOOL_RE.test(p.name || "")) {
      let input = p.arguments ?? p.input;
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { input = null; }
      }
      for (const id of idsFromToolInput(input)) out.ids.add(id);
    }
  }
  if (obj.type === "event_msg" && p.type === "user_message") {
    out.prompt = p.message || "";
    for (const id of idsFromText(out.prompt, notionIndex)) out.ids.add(id);
  }
  return out;
}

// ---- 増分スキャン ----

// path -> { offset, rest, sessionId, cwd, title, agent }
const fileState = new Map();
const MAX_READ = 8 * 1024 * 1024;

function readFrom(path, offset, size) {
  const len = Math.min(size - offset, MAX_READ);
  if (len <= 0) return "";
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, offset);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

function notionPageIndex() {
  const rows = db.prepare("SELECT id, notion_page_id FROM tasks WHERE notion_page_id IS NOT NULL").all();
  return new Map(rows.map((r) => [r.notion_page_id, r.id]));
}

function shortTitle(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function scanFile(file, notionIndex, links) {
  let st = fileState.get(file.path);
  if (!st || file.size < st.offset) {
    st = { offset: 0, rest: "", agent: file.agent, sessionId: null, cwd: null, title: "" };
    if (file.agent === "codex") {
      // rollout-<日時>-<uuid>.jsonl。session_meta が読めなくてもファイル名から ID が取れる
      const m = basename(file.path).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
      if (m) st.sessionId = m[1];
    } else {
      st.sessionId = basename(file.path, ".jsonl");
    }
    fileState.set(file.path, st);
  }
  if (file.size === st.offset) return;
  const chunk = st.rest + readFrom(file.path, st.offset, file.size);
  st.offset = Math.min(file.size, st.offset + MAX_READ);
  const lines = chunk.split("\n");
  st.rest = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    // 速く捨てる: タスクに触れうる行だけ JSON として読む
    if (!/taskdeck|タスク|task_|[0-9a-f]{8}|session_meta|custom-title|"summary"|"cwd"/i.test(line)) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const r = file.agent === "codex" ? parseCodexLine(obj, notionIndex) : parseClaudeLine(obj, notionIndex);
    if (r.sessionId && file.agent === "codex") st.sessionId = r.sessionId;
    if (r.cwd && !st.cwd) st.cwd = r.cwd;
    if (r.title) st.title = shortTitle(r.title);
    if (r.prompt && !st.title) st.title = shortTitle(r.prompt);
    for (const id of r.ids) links.push({ path: file.path, id, ts: obj.timestamp });
  }
}

// 新しく書き足された会話ログを読み、見つけた紐付けを task_sessions に記録する。
// 戻り値は新しく記録(または最終確認時刻を更新)した件数。
export function scanTranscripts({ since = Date.now() - LOOKBACK_MS } = {}) {
  const files = [...listClaudeFiles(since), ...listCodexFiles(since)];
  const notionIndex = notionPageIndex();
  const links = [];
  for (const f of files) {
    try {
      scanFile(f, notionIndex, links);
    } catch {}
  }
  let n = 0;
  for (const l of links) {
    const st = fileState.get(l.path);
    if (!st?.sessionId || !getTask(l.id)) continue;
    const rec = recordTaskSession({
      taskId: l.id,
      agent: st.agent,
      sessionId: st.sessionId,
      cwd: st.cwd,
      title: st.title,
      transcriptPath: l.path,
      via: "scan",
      seenAt: l.ts && !Number.isNaN(Date.parse(l.ts)) ? new Date(l.ts).toISOString() : undefined,
    });
    if (rec) n++;
  }
  // タイトルが後から付いたセッションを反映する
  for (const [path, st] of fileState) {
    if (st.title) {
      db.prepare("UPDATE task_sessions SET title = ? WHERE transcript_path = ? AND title = ''").run(st.title, path);
    }
  }
  return n;
}

// ---- 表示用 ----

// セッション一覧に「作業中か」を付ける。会話ログの更新時刻で判定する
export function withActivity(sessions) {
  const now = Date.now();
  return sessions.map((s) => {
    let lastActivity = null;
    const path = s.transcript_path ||
      (s.agent === "claude" && s.cwd ? claudeTranscriptPath(s.cwd, s.session_id) : null);
    if (path) {
      try { lastActivity = statSync(path).mtimeMs; } catch {}
    }
    const seen = Date.parse(s.last_seen_at.replace(" ", "T") + (s.last_seen_at.includes("Z") ? "" : "Z"));
    const last = Math.max(lastActivity || 0, Number.isNaN(seen) ? 0 : seen);
    return {
      ...s,
      last_activity_at: last ? new Date(last).toISOString() : null,
      active: !!lastActivity && now - lastActivity < ACTIVE_MS,
    };
  });
}

// ---- MCP からの呼び出し元セッションの推定 ----

// Claude Code: MCP サーバーはセッションの作業ディレクトリで起動されるので、
// ~/.claude/projects/<cwd> で直近に更新された会話ログ = 呼び出し元とみなす。
export function detectClaudeSession(cwd) {
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  try {
    const dir = join(CLAUDE_PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
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

// Codex: 直近に更新された rollout のうち、作業ディレクトリが一致するもの。
// 一致が無ければ 2 分以内に更新された rollout が 1 本だけのときに限りそれを採る。
export function detectCodexSession(cwd) {
  const recent = listCodexFiles(Date.now() - 5 * 60 * 1000).sort((a, b) => b.mtime - a.mtime);
  const metaOf = (path) => {
    try {
      const first = readFrom(path, 0, Math.min(statSync(path).size, 64 * 1024)).split("\n")[0];
      const p = JSON.parse(first).payload || {};
      return { id: p.id || p.session_id, cwd: p.cwd };
    } catch {
      return {};
    }
  };
  for (const f of recent) {
    const m = metaOf(f.path);
    if (m.id && m.cwd === cwd) return { sessionId: m.id, transcriptPath: f.path, cwd: m.cwd };
  }
  const veryRecent = recent.filter((f) => Date.now() - f.mtime < 2 * 60 * 1000);
  if (veryRecent.length === 1) {
    const m = metaOf(veryRecent[0].path);
    if (m.id) return { sessionId: m.id, transcriptPath: veryRecent[0].path, cwd: m.cwd };
  }
  return null;
}

export function codexTranscriptPath(sessionId) {
  for (const f of listCodexFiles(Date.now() - LOOKBACK_MS)) {
    if (f.path.includes(sessionId)) return f.path;
  }
  return null;
}

