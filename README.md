# taskdeck

人間とAIコーディングエージェント（Claude Code / Codex など）が同じボードを共有する、完全ローカルのミニマルなカンバン。

- **保存先**: SQLite 1ファイル（`~/.taskdeck/tasks.db`）
- **人間側**: ドラッグ＆ドロップのカンバンUI（`http://localhost:4747`）
- **AI側**: MCPサーバー（stdio）でタスクの追加・一覧・完了・削除
- グループ管理は `project` フィールド（レポジトリ名などを入れる）で行う

> セットアップ手順書（Mac / Windows / MCP 登録 / トラブルシュート）は [docs/SETUP.md](docs/SETUP.md)。
> 紹介動画と台本は [docs/promo/](docs/promo/)。

## ビルド済みアプリを使う（Node.js 不要）

[Releases](https://github.com/TaikiKawa/taskdeck/releases) に Node.js 同梱の自己完結版がある。

| ファイル | 対象 |
|---|---|
| `taskdeck-<ver>-mac-universal.zip` | macOS 13 以降（Apple Silicon / Intel 両対応） |
| `taskdeck-<ver>-win-x64.zip` | Windows 10 / 11（64bit） |

**macOS**: zip を展開して `taskdeck.app` を「アプリケーション」フォルダへ入れて開く。
メニューの **Claude → Claude Code に MCP を登録…** で MCP 登録まで完了する
（`claude` CLI が無い環境では登録コマンドがクリップボードにコピーされる）。
Releases の zip は Developer ID（Alche, inc.）で署名・公証済みなのでそのまま開ける。
自分でビルドした未署名の `.app` は Gatekeeper に止められるので、右クリック → 「開く」、
または `xattr -d com.apple.quarantine taskdeck.app` で解除する。

**Windows**: zip を展開したフォルダ（例: `C:\Users\<あなた>\TaskDeck`）で PowerShell を開き、

```powershell
powershell -ExecutionPolicy Bypass -File windows\install.ps1
```

を実行すると、デスクトップとスタートメニューに「TaskDeck」ショートカットができ、
`claude` CLI があれば MCP も登録される。同梱の `はじめに.txt` にも同じ手順がある。
未署名の PowerShell スクリプトなので SmartScreen が出たら「詳細情報 → 実行」で進める。

## ソースからセットアップ

```bash
npm install
./macos/build.sh   # taskdeck.app をリポジトリ直下にビルド（リポジトリの src/ を参照する開発版）
```

## Mac アプリとして使う（推奨）

```bash
open taskdeck.app
```

- 起動するとサーバー（`src/server.js`）を自動で立ち上げ、ネイティブウインドウでボードを表示
- アプリを終了（Cmd+Q）するとサーバーも一緒に終了
- Dockに入れておけば普通のMacアプリとして使える（Cmd+Rで再読み込み）
- Node.js の場所は nodebrew / Homebrew / ログインシェルのPATH から自動検出
  （明示するなら環境変数 `TASKDECK_NODE`）

## ブラウザで使う場合

```bash
npm run ui
# → http://localhost:4747
```

- 上部の入力欄でタスク追加（Enter）。`#プロジェクト名 タイトル` で追加先グループを指定
- カード左上と詳細パネルの `#12` がタスク番号（変更不可・表示専用、クリックでコピー）。
  Claude に「#12 のタスクやって」と番号で頼める
- カードはドラッグ＆ドロップで列間・列内を移動
- ダブルクリック（または ✎）で編集、✓ で完了、✕ で削除
- プロジェクトのセレクタでグループ絞り込み
- 「＋ グループ」で空のグループを作成（DBに保存されるので、別ブラウザ・macOSアプリ・MCPからも見える）。
  タスクが1件も無いグループを選ぶと「🗑 グループ」で登録解除できる
- Claude がMCP経由で追加したタスクは自動で画面に反映される（SSE）

## Claude Code に MCP を登録

```bash
npm run mcp:register
```

リポジトリの絶対パスを解決して `claude mcp add --scope user taskdeck -- node <path>/src/mcp.js`
を実行する（macOS / Linux / Windows 共通）。`claude` が見つからない場合や
`npm run mcp:register -- --print` を付けた場合は、貼り付け用のコマンドと
Claude Desktop（`claude_desktop_config.json`）・Codex（`config.toml`）の設定例を表示するだけで終わる。

手で登録する場合の例（パスは clone した場所に読み替え）:

```bash
claude mcp add --scope user taskdeck -- node /path/to/taskdeck/src/mcp.js
```

Codex CLI の場合は `~/.codex/config.toml` に:

```toml
[mcp_servers.taskdeck]
command = "node"
args = ["/path/to/taskdeck/src/mcp.js"]
```

## Windows で使う

PowerShell + Edge/Chrome のアプリモードで Mac 版に近い体験にできる。
セットアップ・起動・停止の手順は [windows/README.md](windows/README.md) を参照。

```powershell
powershell -ExecutionPolicy Bypass -File windows\install.ps1   # npm install + ショートカット作成
```

- 🤖 ボタンの「バックグラウンドで実行」は `claude.cmd`（npm -g）/ `claude.exe`（公式インストーラ）を自動検出
- 「デスクトップアプリで開く」の `claude://` リンクは `rundll32 url.dll,FileProtocolHandler` で開く
- `TASKDECK_REPO_ROOTS` は Windows ではセミコロン区切り（下記参照）

## MCP ツール

| ツール | 用途 |
|---|---|
| `task_add` | タスク追加（複数可、`project` でグループ指定） |
| `task_list` | 未完了タスク一覧（project/status/session で絞り込み） |
| `task_update` | ステータス変更・タイトル/メモ/プロジェクト編集 |
| `task_done` | 完了にする（複数可） |
| `task_delete` | 削除 |
| `project_add` | 空のグループを作成（タスクを入れる前から全クライアントに見える） |
| `project_list` | プロジェクト一覧と件数（タスク0件の空グループも含む） |

## エージェントに使わせる（CLAUDE.md への推奨追記）

```markdown
## タスク管理
- このマシンには taskdeck MCP がある。project 名にはレポジトリ名を使うこと。
- セッション開始時に `task_list` で未完了タスクを確認する。
- 作業中に気づいた改善点・セキュリティリスク・フォローアップは、
  その場で `task_add` に登録してから作業を続ける。
- 着手したら `task_update` で status を doing に、完了したら `task_done`。
```

## タスクをボタンひとつで Claude Code に任せる

カードの 🤖 ボタン（または詳細パネルの「🤖 Claudeに依頼」）から、そのタスクを Claude に依頼できる。

実行先は3つ:

- **デスクトップアプリで開く — Claude Code**（デフォルト）: `claude://code/new` ディープリンクで、
  タスク内容と作業フォルダが入った新規セッションがデスクトップアプリに開く。
  アプリの認証をそのまま使うので CLI のログイン不要。内容を確認して送信するだけ
- **デスクトップアプリで開く — Cowork**: 同上で Cowork セッションとして開く
- **バックグラウンドで実行 — claude CLI**: `claude -p` をヘッドレス起動して全自動実行。
  進捗バッジ・停止・実行ログのメモ追記・`--resume` はこのモードのみ。
  ターミナルで `claude /login` 済みであること（`claude setup-token` なら切れにくい）

1. カードにホバー → 🤖 をクリック
2. 作業ディレクトリ（そのプロジェクトのリポジトリ）を指定
   - 一度指定すると `~/.taskdeck/projects.json` に保存され、次回から自動入力
   - Claude が MCP の `task_add` でタスクを登録すると、そのセッションの
     作業ディレクトリが自動で紐付くため、通常は入力不要
   - 未登録でも `~/dev/<プロジェクト名>` や `~/<プロジェクト名>` に同名の
     git リポジトリがあれば自動で推測して入力（探索先は `TASKDECK_REPO_ROOTS` で変更可）
3. 実行モードを選ぶ
   - **新規セッションで実行**: まっさらな Claude Code セッションで開始
   - **登録元セッションの続きで実行**: タスクを登録した Claude セッションを
     `--resume` で再開し、当時の文脈（何を調べていたか・どこまでやったか）を
     引き継いで作業。MCP 経由で登録されたタスクは登録元セッションが自動記録
     されるため、こちらがデフォルトになる
3. 権限モードを選んで実行
   - **安全**: ファイル編集のみ自動許可（`--permission-mode acceptEdits`）
   - **全自動**: すべて許可（`--dangerously-skip-permissions`）。信頼できるタスクのみ

実行中はカードに「🤖 実行中」バッジが出て、⏹ でいつでも停止できる。
完了・失敗・停止すると実行ログ（Claude の最終サマリ）がタスクのメモに追記される。
taskdeck MCP を登録済みなら、Claude 自身が着手時に doing / 完了時に done へ動かすので、
ボード上でそのまま進捗が見える。

- 仕組み: サーバーが `claude -p --output-format stream-json` を headless 起動（同一タスクの多重実行は不可、デフォルト30分でタイムアウト）
- claude CLI の場所は既知のパス→ログインシェル（Windows は `where claude`）の順で自動検出（明示するなら `TASKDECK_CLAUDE`）

## 配布パッケージを作る（メンテナ向け）

```bash
node scripts/package.mjs --platform darwin --arch universal   # dist/taskdeck-<ver>-mac-universal.zip
node scripts/package.mjs --platform win32  --arch x64         # dist/taskdeck-<ver>-win-x64.zip（macOS 上でも作れる）
```

- 同梱する Node.js（既定は実行中の `node` と同じ版）と better-sqlite3 のビルド済みバイナリを
  nodejs.org / GitHub からダウンロードして `dist/` に組み立てる。macOS 版は Node 本体とアドオンを
  `lipo` で universal にする
- macOS の署名・公証は環境変数で有効化:
  `SIGN_IDENTITY="Developer ID Application: <Team> (<TEAMID>)"`、
  `NOTARY_PROFILE=<notarytool のプロファイル名>`（または `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_PASSWORD`）。
  未指定なら ad-hoc 署名になり、配布先で Gatekeeper の解除が必要
- タグ `v*` を push すると [.github/workflows/release.yml](.github/workflows/release.yml) が
  Windows 版をビルドして GitHub Release に添付する。macOS 版は署名用 secrets（ワークフロー冒頭のコメント参照）が
  登録されているときだけ CI でビルドし、無いときはスキップされるので、手元で公証した zip を
  `gh release upload v<ver> dist/taskdeck-<ver>-mac-universal.zip` で添付する

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## 貢献・セキュリティ・ライセンス

- バグ報告や機能要望は Issue テンプレートから。PR の前に [CONTRIBUTING.md](CONTRIBUTING.md) を一読してほしい
- **脆弱性は Issue に書かず**、[SECURITY.md](SECURITY.md) の手順（GitHub の Private vulnerability reporting）で非公開に報告してほしい
- ライセンスは [MIT](LICENSE)。配布版に同梱している Node.js のライセンスは `node/LICENSE` に入っている

## 環境変数

- `TASKDECK_PORT` — UIのポート（デフォルト 4747）
- `TASKDECK_DIR` — DBの保存先ディレクトリ（デフォルト `~/.taskdeck`）
- `TASKDECK_CLAUDE` — claude CLI のパス（未設定なら自動検出）
- `TASKDECK_RUN_TIMEOUT_MS` — Claude実行のタイムアウト（デフォルト30分）
- `TASKDECK_REPO_ROOTS` — リポジトリ推測の探索先。区切りは PATH と同じ（macOS/Linux はコロン `~/dev:~`、
  Windows はセミコロン `C:\dev;%USERPROFILE%`）。デフォルトは `~/dev` と `~`。`~\dev` のような Windows 形式も可
- `TASKDECK_NODE` — アプリ起動時に使う node のパス（macOS の `.app` / Windows の `taskdeck.ps1` が参照）
