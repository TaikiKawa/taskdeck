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
- カードはドラッグ＆ドロップで列間・列内を移動
- ダブルクリック（または ✎）で編集、✓ で完了、✕ で削除
- プロジェクトのセレクタでグループ絞り込み
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
| `project_list` | プロジェクト一覧と件数 |

## エージェントに使わせる（CLAUDE.md への推奨追記）

```markdown
## タスク管理
- このマシンには taskdeck MCP がある。project 名にはレポジトリ名を使うこと。
- セッション開始時に `task_list` で未完了タスクを確認する。
- 作業中に気づいた改善点・セキュリティリスク・フォローアップは、
  その場で `task_add` に登録してから作業を続ける。
- 着手したら `task_update` で status を doing に、完了したら `task_done`。
```

## 環境変数

- `TASKDECK_PORT` — UIのポート（デフォルト 4747）
- `TASKDECK_DIR` — DBの保存先ディレクトリ（デフォルト `~/.taskdeck`）
