#!/usr/bin/env node
// taskdeck の MCP サーバー (src/mcp.js) を Claude Code に登録する (macOS / Linux / Windows 共通)。
//
//   npm run mcp:register            # claude mcp add --scope user taskdeck -- node <abs path>
//   npm run mcp:register -- --print # 実行せず、コマンドと各クライアント用の設定例だけ表示
//   npm run mcp:register -- --scope local
//
// claude CLI が見つからない場合は、手で貼り付けられるコマンドと
// Claude Desktop (claude_desktop_config.json) / Codex (config.toml) の設定例を表示する。
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const argv = process.argv.slice(2);
const printOnly = argv.includes("--print");
const scopeIdx = argv.indexOf("--scope");
const scope = scopeIdx >= 0 && argv[scopeIdx + 1] ? argv[scopeIdx + 1] : "user";

const mcpPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp.js");
const claudeArgs = ["mcp", "add", "--scope", scope, "taskdeck", "--", "node", mcpPath];

// シェルに貼り付ける用の表示 (空白を含むパスは引用符で囲む)
function shellQuote(s) {
  if (!/[\s"'\\$&|<>^()]/.test(s)) return s;
  return IS_WIN ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}
const commandLine = ["claude", ...claudeArgs].map(shellQuote).join(" ");

// Windows で shell:true を使うときの引数クォート (cmd.exe 経由になるため)
function cmdQuote(s) {
  return /\s/.test(s) ? `"${s}"` : s;
}

function claudeAvailable() {
  const bin = process.env.TASKDECK_CLAUDE || "claude";
  // Windows の npm -g は claude.cmd なので shell 経由で解決させる (PATHEXT)
  const r = spawnSync(IS_WIN ? cmdQuote(bin) : bin, ["--version"], {
    stdio: "ignore",
    shell: IS_WIN,
    windowsHide: true,
    timeout: 15000,
  });
  return !r.error && r.status === 0;
}

function configSnippets() {
  const desktopJson = JSON.stringify(
    { mcpServers: { taskdeck: { command: "node", args: [mcpPath] } } },
    null,
    2
  );
  const desktopPath = IS_WIN
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  // TOML の基本文字列は JSON と同じくバックスラッシュをエスケープする
  const codexToml = `[mcp_servers.taskdeck]\ncommand = "node"\nargs = [${JSON.stringify(mcpPath)}]`;
  const codexPath = join(homedir(), ".codex", "config.toml");
  return { desktopJson, desktopPath, codexToml, codexPath };
}

function printManual() {
  const { desktopJson, desktopPath, codexToml, codexPath } = configSnippets();
  console.log(`\n# Claude Code CLI (貼り付けて実行):\n${commandLine}\n`);
  console.log(`# Claude Desktop (${desktopPath}):\n${desktopJson}\n`);
  console.log(`# Codex CLI (${codexPath}):\n${codexToml}\n`);
  console.log(
    `# メモ: "node" が PATH に無いクライアント (デスクトップアプリ等) では command を絶対パスにする:\n#   ${process.execPath}\n`
  );
}

console.log(`MCP server: ${mcpPath}`);
console.log(`実行するコマンド: ${commandLine}`);

if (printOnly) {
  printManual();
  process.exit(0);
}

if (!claudeAvailable()) {
  console.error("\nclaude CLI が見つかりません (PATH または TASKDECK_CLAUDE を確認してください)。");
  console.error("以下を手動で登録してください。");
  printManual();
  process.exit(1);
}

const bin = process.env.TASKDECK_CLAUDE || "claude";
const child = spawn(IS_WIN ? cmdQuote(bin) : bin, IS_WIN ? claudeArgs.map(cmdQuote) : claudeArgs, {
  stdio: "inherit",
  shell: IS_WIN,
  windowsHide: true,
});
child.on("error", (err) => {
  console.error(`claude を起動できませんでした: ${err.message}`);
  printManual();
  process.exit(1);
});
child.on("exit", (code) => {
  if (code === 0) {
    console.log("\n登録しました。`claude mcp list` で確認できます。");
  } else {
    console.error(`\nclaude mcp add が exit ${code} で終了しました。手動登録する場合:`);
    printManual();
  }
  process.exit(code ?? 1);
});
