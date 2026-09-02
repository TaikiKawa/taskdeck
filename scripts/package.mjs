#!/usr/bin/env node
// 配布用パッケージ (Node.js 同梱の自己完結アプリ) を作る。GitHub Releases に添付する zip の生成元。
//
//   node scripts/package.mjs --platform darwin --arch universal   # dist/taskdeck-<ver>-mac-universal.zip
//   node scripts/package.mjs --platform darwin --arch arm64
//   node scripts/package.mjs --platform win32  --arch x64         # dist/taskdeck-<ver>-win-x64.zip
//
// macOS 版は Windows 上では作れない (swiftc / codesign が要る) が、Windows 版は macOS 上でも作れる
// (node.exe と better-sqlite3 の Windows 用ビルド済みバイナリをダウンロードして同梱するだけ)。
//
// 環境変数:
//   NODE_VERSION      同梱する Node.js のバージョン (既定: このスクリプトを動かしている node と同じ)
//   SIGN_IDENTITY     macOS: 署名 ID。例 "Developer ID Application: Alche, inc. (GS68A638AG)"
//                     未指定なら ad-hoc 署名 (Gatekeeper に止められるので配布には署名 + 公証が必要)
//   NOTARY_PROFILE    macOS: `xcrun notarytool store-credentials <name>` で保存したプロファイル名
//   APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD
//                     NOTARY_PROFILE の代わりに直接指定 (CI 用)。App 用パスワードは appleid.apple.com で発行
//   いずれかが揃っていれば公証 (notarize) + ステープルまで行う。
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sqliteVersion = JSON.parse(
  readFileSync(join(root, "node_modules", "better-sqlite3", "package.json"), "utf8")
).version;

// ---- 引数 ----
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const platform = arg("--platform", process.platform);
const arch = arg("--arch", platform === "darwin" ? "universal" : "x64");
const nodeVersion = process.env.NODE_VERSION || process.version;

if (!["darwin", "win32"].includes(platform)) fail(`--platform は darwin か win32: ${platform}`);
if (platform === "darwin" && !["arm64", "x64", "universal"].includes(arch)) fail(`macOS の --arch は arm64 / x64 / universal: ${arch}`);
if (platform === "win32" && !["x64", "arm64"].includes(arch)) fail(`Windows の --arch は x64 / arm64: ${arch}`);
if (platform === "darwin" && process.platform !== "darwin") fail("macOS 版のパッケージは macOS 上でしか作れません (swiftc / codesign が必要)");
if (!/^v\d+\.\d+\.\d+$/.test(nodeVersion)) fail(`NODE_VERSION の形式が不正: ${nodeVersion}`);

const label = platform === "darwin" ? "mac" : "win";
const name = `taskdeck-${pkg.version}-${label}-${arch}`;
const dist = join(root, "dist");
const cache = join(dist, "cache");
const stage = join(dist, "stage", name);
const zipPath = join(dist, `${name}.zip`);
for (const d of [dist, cache]) mkdirSync(d, { recursive: true });
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

console.log(`[package] ${name}  node ${nodeVersion}  better-sqlite3 ${sqliteVersion}`);

// ---- ユーティリティ ----
function fail(msg) {
  console.error(`[package] ERROR: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const shown = [cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
  console.log(`[package] $ ${shown}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
}

function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}: ${r.stderr}`);
  return r.stdout;
}

async function download(url) {
  const dest = join(cache, basename(url));
  if (existsSync(dest)) {
    console.log(`[package] cache hit: ${basename(url)}`);
    return dest;
  }
  console.log(`[package] download ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  const tmp = dest + ".part";
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, dest);
  return dest;
}

// tar (macOS / Linux / Windows 10+ の bsdtar) で書庫から特定メンバーだけ取り出す。zip も読める。
function extract(archive, members, outDir) {
  mkdirSync(outDir, { recursive: true });
  run("tar", ["-xf", archive, "-C", outDir, "--strip-components=1", ...members]);
}

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), `taskdeck-${prefix}-`));
}

// Node.js の ABI (process.versions.modules) を調べる。同梱する Node と同じ ABI の
// better-sqlite3 バイナリが必要。
async function nodeAbi() {
  if (nodeVersion === process.version) return process.versions.modules;
  const res = await fetch("https://nodejs.org/dist/index.json");
  if (!res.ok) throw new Error(`nodejs.org index.json: ${res.status}`);
  const hit = (await res.json()).find((e) => e.version === nodeVersion);
  if (!hit) throw new Error(`Node ${nodeVersion} が nodejs.org に見つかりません`);
  return hit.modules;
}

// ---- Node.js ランタイム ----
// darwin: <dest>/bin/node, win32: <dest>/node.exe。LICENSE も同梱する (MIT 表示義務)。
async function fetchNode(nodeArch, dest) {
  const base = `https://nodejs.org/dist/${nodeVersion}`;
  const dirName = `node-${nodeVersion}-${platform === "darwin" ? "darwin" : "win"}-${nodeArch}`;
  const out = tmpDir(`node-${nodeArch}`);
  if (platform === "darwin") {
    const tgz = await download(`${base}/${dirName}.tar.gz`);
    extract(tgz, [`${dirName}/bin/node`, `${dirName}/LICENSE`], out);
    mkdirSync(join(dest, "bin"), { recursive: true });
    cpSync(join(out, "bin", "node"), join(dest, "bin", "node"));
    chmodSync(join(dest, "bin", "node"), 0o755);
  } else {
    const zip = await download(`${base}/${dirName}.zip`);
    extract(zip, [`${dirName}/node.exe`, `${dirName}/LICENSE`], out);
    mkdirSync(dest, { recursive: true });
    cpSync(join(out, "node.exe"), join(dest, "node.exe"));
  }
  cpSync(join(out, "LICENSE"), join(dest, "LICENSE"));
  rmSync(out, { recursive: true, force: true });
}

// ---- better-sqlite3 のビルド済みバイナリ ----
async function fetchSqliteAddon(nodeArch, abi) {
  const file = `better-sqlite3-v${sqliteVersion}-node-v${abi}-${platform}-${nodeArch}.tar.gz`;
  const tgz = await download(
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/${file}`
  );
  const out = tmpDir(`sqlite-${nodeArch}`);
  run("tar", ["-xf", tgz, "-C", out]);
  const addon = join(out, "build", "Release", "better_sqlite3.node");
  if (!existsSync(addon)) throw new Error(`アドオンが見つかりません: ${addon}`);
  return addon;
}

// ---- アプリ本体のコピー ----
function copyAppFiles(appDir) {
  const files = [
    "src",
    "public",
    "package.json",
    "package-lock.json",
    "scripts/register-mcp.js",
    "README.md",
    "docs/SETUP.md",
    "LICENSE",
  ];
  if (platform === "win32") files.push("windows");
  for (const f of files) {
    const src = join(root, f);
    if (!existsSync(src)) continue;
    cpSync(src, join(appDir, f), { recursive: true });
  }
}

// 本番依存 (dependencies) だけを node_modules からコピーする。ネットワーク不要。
function copyProdModules(appDir) {
  const npm = IS_WIN ? "npm.cmd" : "npm";
  const out = runCapture(npm, ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, shell: IS_WIN });
  const dirs = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((p) => p !== root);
  for (const dir of dirs) {
    const rel = relative(root, dir);
    if (!rel.startsWith("node_modules")) continue;
    cpSync(dir, join(appDir, rel), { recursive: true, dereference: true });
  }
  // better-sqlite3 の SQLite ソースとビルド中間物は不要 (~10MB)。バイナリは後で差し替える
  const bs = join(appDir, "node_modules", "better-sqlite3");
  for (const d of ["deps", "src", "build", "binding.gyp"]) rmSync(join(bs, d), { recursive: true, force: true });
  console.log(`[package] copied ${dirs.length} production packages`);
}

function installSqliteAddon(appDir, addonPath) {
  const dest = join(appDir, "node_modules", "better-sqlite3", "build", "Release");
  mkdirSync(dest, { recursive: true });
  cpSync(addonPath, join(dest, "better_sqlite3.node"));
}

// ---- macOS: 署名と公証 ----
function codesign(app) {
  const identity = process.env.SIGN_IDENTITY;
  const ent = join(root, "macos", "entitlements.plist");
  const appDir = join(app, "Contents", "Resources", "app");
  const machos = [
    join(appDir, "node", "bin", "node"),
    join(appDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
  ];
  if (!identity) {
    console.log("[package] SIGN_IDENTITY 未指定: ad-hoc 署名 (配布には Developer ID 署名 + 公証が必要)");
    for (const f of machos) run("codesign", ["--force", "--sign", "-", f]);
    run("codesign", ["--force", "--sign", "-", app]);
    return false;
  }
  // 内側 (同梱 node, ネイティブアドオン) → 外側 (.app) の順に Hardened Runtime で署名する
  const common = ["--force", "--options", "runtime", "--timestamp", "--entitlements", ent, "--sign", identity];
  for (const f of machos) run("codesign", [...common, f]);
  run("codesign", [...common, app]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  return true;
}

function zipApp(app) {
  rmSync(zipPath, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zipPath]);
}

function notarize(app) {
  const profile = process.env.NOTARY_PROFILE;
  const { APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD } = process.env;
  let creds;
  if (profile) creds = ["--keychain-profile", profile];
  else if (APPLE_ID && APPLE_TEAM_ID && APPLE_APP_PASSWORD)
    creds = ["--apple-id", APPLE_ID, "--team-id", APPLE_TEAM_ID, "--password", APPLE_APP_PASSWORD];
  if (!creds) {
    console.log("[package] 公証はスキップ (NOTARY_PROFILE か APPLE_ID/APPLE_TEAM_ID/APPLE_APP_PASSWORD を設定すると実行)");
    return false;
  }
  zipApp(app);
  run("xcrun", ["notarytool", "submit", zipPath, ...creds, "--wait"]);
  run("xcrun", ["stapler", "staple", app]);
  run("xcrun", ["stapler", "validate", app]);
  return true;
}

// ---- 本体 ----
async function packageMac() {
  const app = join(stage, "taskdeck.app");
  const swiftArch = arch === "universal" ? "universal" : arch === "x64" ? "x86_64" : "arm64";
  run("bash", [join(root, "macos", "build.sh"), "--out", app, "--repo", "none", "--arch", swiftArch]);

  const appDir = join(app, "Contents", "Resources", "app");
  mkdirSync(appDir, { recursive: true });
  copyAppFiles(appDir);
  copyProdModules(appDir);

  const abi = await nodeAbi();
  const nodeDir = join(appDir, "node");
  if (arch === "universal") {
    // Node 本体も SQLite アドオンも arm64 / x64 を lipo で束ねる
    const a = tmpDir("uni-arm64");
    const x = tmpDir("uni-x64");
    await fetchNode("arm64", a);
    await fetchNode("x64", x);
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    run("lipo", ["-create", join(a, "bin", "node"), join(x, "bin", "node"), "-output", join(nodeDir, "bin", "node")]);
    chmodSync(join(nodeDir, "bin", "node"), 0o755);
    cpSync(join(a, "LICENSE"), join(nodeDir, "LICENSE"));
    const addonA = await fetchSqliteAddon("arm64", abi);
    const addonX = await fetchSqliteAddon("x64", abi);
    const uni = join(tmpDir("uni-addon"), "better_sqlite3.node");
    run("lipo", ["-create", addonA, addonX, "-output", uni]);
    installSqliteAddon(appDir, uni);
  } else {
    await fetchNode(arch, nodeDir);
    installSqliteAddon(appDir, await fetchSqliteAddon(arch, abi));
  }

  const signed = codesign(app);
  const notarized = signed && notarize(app);
  zipApp(app);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  // spctl は「未公証の Developer ID」「ad-hoc」を rejected と言う。参考表示のみ
  const spctl = spawnSync("spctl", ["--assess", "--type", "exec", "-vv", app], { encoding: "utf8" });
  console.log(`[package] spctl: ${(spctl.stdout + spctl.stderr).trim()}`);
  return { signed, notarized };
}

async function packageWin() {
  const appDir = join(stage, "TaskDeck");
  mkdirSync(appDir, { recursive: true });
  copyAppFiles(appDir);
  copyProdModules(appDir);
  await fetchNode(arch, join(appDir, "node"));
  installSqliteAddon(appDir, await fetchSqliteAddon(arch, await nodeAbi()));
  writeFileSync(
    join(appDir, "はじめに.txt"),
    [
      `TaskDeck ${pkg.version} (Windows ${arch}) — Node.js ${nodeVersion} 同梱版`,
      "",
      "1. このフォルダごと好きな場所に置く (例: C:\\Users\\<あなた>\\TaskDeck)",
      "2. PowerShell でこのフォルダに移動し、次を実行する:",
      "     powershell -ExecutionPolicy Bypass -File windows\\install.ps1",
      "   → デスクトップとスタートメニューに「TaskDeck」ショートカットができ、",
      "     claude CLI があれば Claude Code に MCP も登録される",
      "3. デスクトップの「TaskDeck」をダブルクリックで起動",
      "",
      "Node.js のインストールは不要です (node\\node.exe を同梱)。",
      "詳しい使い方: README.md / docs\\SETUP.md",
      "",
    ].join("\r\n"),
    "utf8"
  );
  rmSync(zipPath, { force: true });
  run("tar", ["-a", "-cf", zipPath, "-C", stage, "TaskDeck"]);
  return { signed: false, notarized: false };
}

const result = platform === "darwin" ? await packageMac() : await packageWin();
const size = (await import("node:fs")).statSync(zipPath).size;
console.log("");
console.log(`[package] done: ${relative(root, zipPath)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
if (platform === "darwin") {
  console.log(`[package] signed: ${result.signed ? process.env.SIGN_IDENTITY : "ad-hoc"}  notarized: ${result.notarized}`);
}
