// Claude Code へのヘッドレス dispatch。
// タスクをプロンプト化して `claude -p` を spawn し、結果をタスクのメモに書き戻す。
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, normalize } from "node:path";
import { getTask, updateTask } from "./db.js";

const IS_WIN = process.platform === "win32";
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

// 先頭の `~` をホームに展開する。Windows では `~\dev` も `~/dev` も受け付け、
// 区切り文字が混在しないよう normalize する (POSIX 側の挙動は従来どおり)。
export function expandHome(p) {
  const out = p.replace(/^~(?=[\\/]|$)/, () => homedir());
  return IS_WIN ? normalize(out) : out;
}

// タスク登録時に呼ばれる自動紐付け。呼び出し元(MCPサーバー)の cwd を
// プロジェクトの作業ディレクトリとして記録する。既存の紐付けは上書きしない。
export function maybeRegisterProjectPath(project, cwd) {
  try {
    project = (project || "").trim();
    if (!project || project === "inbox") return;
    if (!cwd || cwd === "/" || cwd === homedir()) return;
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return;
    if (loadProjectPaths()[project]) return;
    saveProjectPath(project, cwd);
  } catch {
    // 紐付けは補助機能なので失敗しても本体処理は続行
  }
}

// 未登録プロジェクトのリポジトリ位置を推測する。
// TASKDECK_REPO_ROOTS(PATH と同じ区切り: POSIX は ":"、Windows は ";"。
// デフォルト ~/dev:~ 相当)配下にプロジェクト名と同名の git リポジトリがあればそれを返す。
// Windows は "C:\dev" のようにドライブ文字にコロンを含むため ":" では分割できない。
const REPO_ROOTS = (process.env.TASKDECK_REPO_ROOTS || ["~/dev", "~"].join(delimiter))
  .split(delimiter)
  .map((s) => s.trim())
  .filter(Boolean);

export function guessProjectPath(project) {
  if (!project || project === "inbox") return null;
  for (const root of REPO_ROOTS) {
    const p = join(expandHome(root), project);
    try {
      if (statSync(p).isDirectory() && existsSync(join(p, ".git"))) return p;
    } catch {}
  }
  return null;
}

// ---- claude CLI の場所を解決 ----
// .app から起動されたサーバーは素の PATH しか持たないため、既知の場所 →
// ログインシェルの順で探す。

let claudeBin = null;

function posixClaudeCandidates() {
  return [
    // このサーバーを動かしている node と同じ bin (nodebrew/nvm 等のグローバルインストール先)
    join(dirname(process.execPath), "claude"),
    join(homedir(), ".claude", "local", "claude"),
    join(homedir(), ".nodebrew", "current", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".bun", "bin", "claude"),
    join(homedir(), "Library", "pnpm", "claude"),
    join(homedir(), ".volta", "bin", "claude"),
  ];
}

function windowsClaudeCandidates() {
  const home = homedir();
  const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  const nodeDir = dirname(process.execPath);
  return [
    // このサーバーを動かしている node と同じ場所 (nvm-windows 等では npm -g がここに入る)
    join(nodeDir, "claude.cmd"),
    join(nodeDir, "claude.exe"),
    // npm -g の既定 prefix (%APPDATA%\npm)
    join(appData, "npm", "claude.cmd"),
    // ネイティブインストーラ (irm https://claude.ai/install.ps1 | iex)
    join(localAppData, "Programs", "claude", "claude.exe"),
    join(home, ".local", "bin", "claude.exe"),
    join(home, ".claude", "local", "claude.exe"),
    join(home, ".claude", "local", "claude.cmd"),
    // pnpm / bun / volta / scoop
    join(localAppData, "pnpm", "claude.cmd"),
    join(home, ".bun", "bin", "claude.exe"),
    join(localAppData, "Volta", "bin", "claude.exe"),
    join(home, "scoop", "shims", "claude.exe"),
  ];
}

// POSIX: .app 起動などPATHが素の環境向け: ログインシェル(-lc)、だめなら
// PATH設定が .zshrc にある場合に備えて対話シェル(-lic)でも探す
async function findClaudeViaLoginShell() {
  for (const flag of ["-lc", "-lic"]) {
    const found = await new Promise((resolve) => {
      execFile("/bin/zsh", [flag, "command -v claude"], { timeout: 8000 }, (err, stdout) =>
        resolve(err ? "" : stdout.trim().split("\n").pop())
      );
    });
    if (found && existsSync(found)) return found;
  }
  return "";
}

// Windows: `where claude` で PATH 上を探す (where.exe は System32 の実行ファイルなので
// cmd.exe を介さず直接呼べる)。拡張子なしの `claude` は bash 用シェルスクリプトで
// Windows では実行できないため、.exe/.cmd/.bat のものだけを採用する。
function findClaudeViaWhere() {
  const where = join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
  return new Promise((resolve) => {
    execFile(where, ["claude"], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve("");
      const hit = String(stdout)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((p) => /\.(exe|cmd|bat)$/i.test(p) && existsSync(p));
      resolve(hit || "");
    });
  });
}

async function resolveClaude() {
  if (claudeBin) return claudeBin;
  if (process.env.TASKDECK_CLAUDE) return (claudeBin = process.env.TASKDECK_CLAUDE);
  const candidates = IS_WIN ? windowsClaudeCandidates() : posixClaudeCandidates();
  for (const c of candidates) {
    if (existsSync(c)) return (claudeBin = c);
  }
  const found = IS_WIN ? await findClaudeViaWhere() : await findClaudeViaLoginShell();
  if (found) return (claudeBin = found);
  throw new Error(
    "claude CLI が見つかりません。環境変数 TASKDECK_CLAUDE にパスを設定してください"
  );
}

// claude を spawn するときの実行ファイルと引数を決める。
// Windows の npm -g 版 claude は `claude.cmd` (batch ラッパ) で、Node 22 は
// .cmd/.bat を shell なしで spawn できない (CVE-2024-27980 対策で EINVAL)。
// 同じディレクトリの node_modules に JS エントリ (cli.js) があればそれを
// このサーバー自身の node で直接実行し (shell 不要・引数のクォート問題なし)、
// 見つからなければ shell:true で cmd.exe 経由で起動する。
function claudeSpawnSpec(bin, args) {
  if (!IS_WIN || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args, shell: false };
  const cliJs = join(dirname(bin), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (existsSync(cliJs)) return { file: process.execPath, args: [cliJs, ...args], shell: false };
  // cmd.exe 経由: 空白を含む引数(主にパス)を二重引用符で囲む。
  // claude の引数自体に空白や特殊文字は含まれない前提
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return { file: q(bin), args: args.map(q), shell: true };
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

function buildPrompt(task, { resume = false } = {}) {
  const notes = notesToText(task.notes);
  const lead = resume
    ? `このセッションで扱っていた taskdeck のタスクの続きを任されました。これまでの文脈を踏まえて、以下のタスクを完了してください。`
    : `taskdeck のカンバンボードからタスクを任されました。以下のタスクを完了してください。`;
  return `${lead}

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

// ---- デスクトップアプリへの受け渡し ----
// claude:// ディープリンクで Claude デスクトップアプリに新規セッションを開く。
// アプリ側の認証を使うため CLI のログイン状態に依存しない。
// (q はアプリ側で新規セッション画面にプリフィルされる)

export function dispatchToDesktop(id, { cwd, app = "code" } = {}) {
  const task = getTask(id);
  if (!task) throw new Error(`task ${id} not found`);
  if (!cwd) throw new Error("作業ディレクトリが未指定です");
  cwd = expandHome(cwd.trim());
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`作業ディレクトリが存在しません: ${cwd}`);
  }
  const host = app === "cowork" ? "cowork" : "code";
  const full = buildPrompt(task);
  // Windows は ShellExecute → ハンドラのコマンドライン (上限 32767 文字) に URL が
  // そのまま載るため、日本語(1文字 9 バイトに膨らむ)を含むプロンプトは短めに切り詰める
  const MAX_URL = IS_WIN ? 30000 : Infinity;
  let promptLen = 4000;
  let url;
  do {
    url =
      `claude://${host}/new?q=${encodeURIComponent(full.slice(0, promptLen))}` +
      `&folder=${encodeURIComponent(cwd)}&source=taskdeck`;
    promptLen -= 500;
  } while (url.length > MAX_URL && promptLen > 0);
  openExternal(url);
  updateTask(id, { status: "doing" });
  return { taskId: id, target: host, cwd };
}

// URL を OS の既定ハンドラ (claude:// なら Claude デスクトップアプリ) で開く。
function openExternal(url) {
  let file, args;
  if (process.platform === "darwin") {
    [file, args] = ["open", [url]];
  } else if (IS_WIN) {
    // `cmd /c start "" "<url>"` は `&` などを cmd 向けに `^&` エスケープしないと
    // 引数が途中で切れる。rundll32 url.dll,FileProtocolHandler はシェルを介さず
    // 引数をそのまま ShellExecute に渡すのでエスケープ不要 (Go の browser パッケージ等と同じ手法)。
    [file, args] = ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  } else {
    [file, args] = ["xdg-open", [url]];
  }
  const proc = spawn(file, args, { stdio: "ignore", detached: true, windowsHide: true });
  // 'error' を拾わないと open/xdg-open が無い環境でサーバーごと落ちる
  proc.on("error", (err) => console.error(`URL を開けませんでした (${file}): ${err.message}`));
  proc.unref();
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
  if (IS_WIN) {
    // Windows にはプロセスグループ kill (負の pid) が無いので taskkill でツリーごと止める。
    // shell:true 経由の場合 pid は cmd.exe のものだが /T で子孫 (claude, node) も止まる
    try {
      const tk = spawn("taskkill", ["/pid", String(run.proc.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      tk.on("error", () => {
        try { run.proc.kill(); } catch {}
      });
    } catch {
      try { run.proc.kill(); } catch {}
    }
    return;
  }
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

export async function dispatchTask(
  id,
  { cwd, mode = "safe", resumeSession = null } = {},
  onChange = () => {}
) {
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
  if (resumeSession) args.push("--resume", resumeSession);
  if (mode === "full") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", "acceptEdits");

  const session = `deck-${id}-${Date.now()}`;
  const run = {
    taskId: id,
    session,
    resumeSession,
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
  // session カラムは「登録元セッションID」を保持したいので上書きしない
  updateTask(id, { status: "doing" });

  // detached (POSIX): 自前のプロセスグループにして、停止時にグループごと kill できるようにする。
  // Windows では detached だと新しいコンソールが付くだけで利点が無く、停止は taskkill /T で行う。
  // PATH には claude と node の場所を前置する(.app 起動のサーバーはPATHが素のため。
  // claude 本体が `#!/usr/bin/env node` で node を探すのにも必要)。
  // Windows の環境変数名は大文字小文字を区別しないため、既存のキー (Path など) をそのまま使う
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const spec = claudeSpawnSpec(bin, args);
  const proc = spawn(spec.file, spec.args, {
    cwd,
    env: {
      ...process.env,
      [pathKey]: [dirname(bin), dirname(process.execPath), process.env[pathKey] || ""].join(delimiter),
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: !IS_WIN,
    shell: spec.shell,
    windowsHide: true,
  });
  run.proc = proc;
  proc.stdin.on("error", () => {}); // 起動失敗時の EPIPE を握りつぶす
  proc.stdin.end(buildPrompt(task, { resume: !!resumeSession }));

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
