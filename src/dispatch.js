// Claude Code へのヘッドレス dispatch。
// タスクをプロンプト化して `claude -p` を spawn し、結果をタスクのメモに書き戻す。
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTask, updateTask } from "./db.js";

const dataDir = process.env.TASKDECK_DIR || join(homedir(), ".taskdeck");
const pathsFile = join(dataDir, "projects.json");
const RUN_TIMEOUT_MS = Number(process.env.TASKDECK_RUN_TIMEOUT_MS || 30 * 60 * 1000);
// 終了した run をバッジ表示のためにしばらく残す時間
const RUN_LINGER_MS = 5 * 60 * 1000;

// ---- project → リポジトリパスの対応表 (~/.taskdeck/projects.json) ----

export function loadProjectPaths() {
  try {
    return JSON.parse(readFileSync(pathsFile, "utf8"));
  } catch {
    return {};
  }
}

export function saveProjectPath(project, path) {
  const paths = loadProjectPaths();
  if (paths[project] === path) return;
  paths[project] = path;
  writeFileSync(pathsFile, JSON.stringify(paths, null, 2) + "\n");
}

export function expandHome(p) {
  return p.replace(/^~(?=\/|$)/, homedir());
}

// ---- claude CLI の場所を解決 ----
// .app から起動されたサーバーは素の PATH しか持たないため、既知の場所 →
// ログインシェルの順で探す。

let claudeBin = null;

async function resolveClaude() {
  if (claudeBin) return claudeBin;
  if (process.env.TASKDECK_CLAUDE) return (claudeBin = process.env.TASKDECK_CLAUDE);
  const candidates = [
    join(homedir(), ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(homedir(), ".local", "bin", "claude"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return (claudeBin = c);
  }
  const found = await new Promise((resolve) => {
    execFile("/bin/zsh", ["-lc", "command -v claude"], (err, stdout) =>
      resolve(err ? "" : stdout.trim().split("\n").pop())
    );
  });
  if (found) return (claudeBin = found);
  throw new Error(
    "claude CLI が見つかりません。環境変数 TASKDECK_CLAUDE にパスを設定してください"
  );
}

// ---- プロンプト生成 ----

function notesToText(notes) {
  if (!notes) return "";
  if (!/^\s*</.test(notes)) return notes.trim();
  return notes
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|div|li|h1|h2|h3|blockquote|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/​/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPrompt(task) {
  const notes = notesToText(task.notes);
  return `taskdeck のカンバンボードからタスクを任されました。以下のタスクを完了してください。

# タスク
- taskdeck ID: ${task.id}
- プロジェクト: ${task.project}
- タイトル: ${task.title}
${notes ? `\n## メモ\n${notes}\n` : ""}
# 進め方
- taskdeck MCP が使える場合: 着手時に task_update で id=${task.id} の status を "doing" に、完了したら task_done で完了にすること。使えない環境なら状態更新は不要。
- 質問はできない環境なので、判断に迷う点は安全側に倒して進められる範囲で完了させること。
- 最後に「何をしたか」の簡潔なサマリ(数行)を出力して終了すること。
`;
}

// ---- 実行管理 ----

const runs = new Map(); // taskId -> run

function publicRun({ proc, timer, ...pub }) {
  return pub;
}

export function listRuns() {
  return [...runs.values()].map(publicRun);
}

// claude は子プロセスを持つため、プロセスグループごと止める
function killRun(run) {
  try {
    process.kill(-run.proc.pid, "SIGTERM");
  } catch {
    try { run.proc.kill("SIGTERM"); } catch {}
  }
}

export function stopRun(taskId) {
  const run = runs.get(taskId);
  if (!run || run.status !== "running") throw new Error("実行中のタスクではありません");
  run.stopRequested = true;
  run.error = "ユーザーが停止しました";
  killRun(run);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 実行結果をタスクのメモ末尾に追記する。
// メモが HTML 形式ならホワイトリスト内のタグで、Markdown/プレーンならテキストで揃える。
function appendRunLog(run) {
  const task = getTask(run.taskId);
  if (!task) return;
  const when = new Date().toLocaleString("ja-JP");
  const icon = run.status === "done" ? "✅" : run.status === "stopped" ? "⏹" : "⚠️";
  const body =
    run.status === "done"
      ? run.resultText || "(出力なし)"
      : `${run.error}${run.resultText ? `\n---\n${run.resultText}` : ""}`;
  let notes = task.notes || "";
  if (!notes || /^\s*</.test(notes)) {
    const html =
      `<h3>${icon} Claude実行ログ (${escapeHtml(when)})</h3>` +
      body
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => `<p>${escapeHtml(l)}</p>`)
        .join("");
    notes = notes + html;
  } else {
    notes = `${notes}\n\n### ${icon} Claude実行ログ (${when})\n${body}`;
  }
  updateTask(run.taskId, { notes });
}

function finishRun(run, error, onChange) {
  if (run.status !== "running") return;
  clearTimeout(run.timer);
  run.endedAt = new Date().toISOString();
  run.error = error || "";
  run.status = error ? (run.stopRequested ? "stopped" : "error") : "done";
  try {
    appendRunLog(run);
  } catch (err) {
    console.error("appendRunLog failed:", err);
  }
  onChange();
  setTimeout(() => {
    if (runs.get(run.taskId) === run) runs.delete(run.taskId);
  }, RUN_LINGER_MS).unref?.();
}

export async function dispatchTask(id, { cwd, mode = "safe" } = {}, onChange = () => {}) {
  const task = getTask(id);
  if (!task) throw new Error(`task ${id} not found`);
  if (runs.get(id)?.status === "running") throw new Error("このタスクは既にClaudeが実行中です");
  if (!cwd) throw new Error("作業ディレクトリが未指定です");
  cwd = expandHome(cwd.trim());
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`作業ディレクトリが存在しません: ${cwd}`);
  }
  const bin = await resolveClaude();

  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (mode === "full") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", "acceptEdits");

  const session = `deck-${id}-${Date.now()}`;
  const run = {
    taskId: id,
    session,
    status: "running",
    mode,
    cwd,
    startedAt: new Date().toISOString(),
    endedAt: null,
    resultText: "",
    error: "",
    lastText: "",
    stopRequested: false,
  };
  runs.set(id, run);
  updateTask(id, { status: "doing", session });

  // detached: 自前のプロセスグループにして、停止時にグループごと kill できるようにする
  const proc = spawn(bin, args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  run.proc = proc;
  proc.stdin.on("error", () => {}); // 起動失敗時の EPIPE を握りつぶす
  proc.stdin.end(buildPrompt(task));

  let stderrBuf = "";
  proc.stderr.on("data", (d) => {
    stderrBuf = (stderrBuf + d).slice(-4000);
  });

  let lineBuf = "";
  proc.stdout.on("data", (d) => {
    lineBuf += d;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant") {
          const texts = (msg.message?.content || [])
            .filter((c) => c.type === "text")
            .map((c) => c.text);
          if (texts.length) run.lastText = texts.join("\n").slice(-2000);
        } else if (msg.type === "result") {
          run.resultText = String(msg.result ?? "").slice(0, 8000);
          if (msg.is_error && !run.error) {
            run.error = run.resultText || "claude がエラーで終了しました";
          }
        }
      } catch {
        // stream-json 以外の行は無視
      }
    }
  });

  run.timer = setTimeout(() => {
    if (run.status === "running") {
      run.error = `タイムアウト(${Math.round(RUN_TIMEOUT_MS / 60000)}分)で停止しました`;
      run.stopRequested = true;
      killRun(run);
    }
  }, RUN_TIMEOUT_MS);
  run.timer.unref?.();

  proc.on("error", (err) => {
    finishRun(run, `claude を起動できませんでした: ${err.message}`, onChange);
  });
  const onEnd = (code) => {
    let error = run.error;
    if (!error && code !== 0) {
      const tail = stderrBuf.trim().slice(-500);
      error = `claude が異常終了しました (exit ${code ?? "?"})${tail ? `: ${tail}` : ""}`;
    }
    finishRun(run, error, onChange);
  };
  proc.on("close", onEnd);
  // 孫プロセスが stdio を掴んだままだと close が来ないことがあるため、
  // exit 後しばらくして close が来なければそこで確定させる
  proc.on("exit", (code) => {
    setTimeout(() => onEnd(code), 3000).unref?.();
  });

  onChange();
  return publicRun(run);
}
