# taskdeck

人間とAIコーディングエージェント（Claude Code / Codex など）が同じボードを共有する、完全ローカルのミニマルなカンバン。

- **保存先**: SQLite 1ファイル（`~/.taskdeck/tasks.db`）
- **人間側**: ドラッグ＆ドロップのカンバンUI（`http://localhost:4747`）
- **AI側**: MCPサーバー（stdio）でタスクの追加・一覧・完了・削除
- グループ管理は `project` フィールド（レポジトリ名などを入れる）で行う

## セットアップ

```bash
npm install
./macos/build.sh   # taskdeck.app をリポジトリ直下にビルド
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
claude mcp add --scope user taskdeck -- node /Users/taiki/dev/taskdeck/src/mcp.js
```

Codex CLI の場合は `~/.codex/config.toml` に:

```toml
[mcp_servers.taskdeck]
command = "node"
args = ["/Users/taiki/dev/taskdeck/src/mcp.js"]
```

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
- claude CLI の場所は既知のパス→ログインシェルの順で自動検出（明示するなら `TASKDECK_CLAUDE`）

## 環境変数

- `TASKDECK_PORT` — UIのポート（デフォルト 4747）
- `TASKDECK_DIR` — DBの保存先ディレクトリ（デフォルト `~/.taskdeck`）
- `TASKDECK_CLAUDE` — claude CLI のパス（未設定なら自動検出）
- `TASKDECK_RUN_TIMEOUT_MS` — Claude実行のタイムアウト（デフォルト30分）
- `TASKDECK_REPO_ROOTS` — リポジトリ推測の探索先（コロン区切り、デフォルト `~/dev:~`）
