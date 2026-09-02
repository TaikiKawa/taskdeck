# taskdeck を Windows で使う

Electron もコンパイラも使わず、PowerShell + Edge/Chrome のアプリモードで
macOS 版 `taskdeck.app` に近い体験にするためのファイル一式。

| ファイル | 役割 |
|---|---|
| `install.ps1` | Node.js の確認 → `npm install` → デスクトップ / スタートメニューに「TaskDeck」ショートカット作成 |
| `taskdeck.ps1` | サーバー (`src/server.js`) を裏で起動し、Edge / Chrome の `--app` ウインドウでボードを開く |
| `taskdeck.vbs` | `taskdeck.ps1` をコンソールを出さずに起動する (ショートカットの実体) |
| `taskdeck.ico` | ショートカット用アイコン (macOS 版と同じデザイン) |

## 前提

- Windows 10 / 11
- [Node.js](https://nodejs.org/) 20 以上 (LTS 推奨)。nvm-windows / volta / fnm 経由でも可
- Claude Code CLI (`npm i -g @anthropic-ai/claude-code` または公式インストーラ) — 🤖 ボタンを使う場合

## セットアップ

PowerShell でリポジトリを clone した場所に移動して:

```powershell
powershell -ExecutionPolicy Bypass -File windows\install.ps1
```

`.ps1` を直接実行できるようにしておきたい場合は、一度だけ:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

を実行すれば `.\windows\install.ps1` のように呼べる
(ショートカットは `-ExecutionPolicy Bypass` 付きで起動するので、この設定が無くても動く)。

`npm install` で better-sqlite3 のビルド済みバイナリが取得できなかった場合は
Visual Studio Build Tools (C++ デスクトップ開発) と Python 3 が必要。スクリプトが案内を表示する。

## 起動

- デスクトップまたはスタートメニューの **TaskDeck** をダブルクリック
- あるいは `powershell -ExecutionPolicy Bypass -File windows\taskdeck.ps1`

サーバーが `http://localhost:4747` で立ち上がり、Edge (無ければ Chrome) が
アドレスバー無しのアプリウインドウでボードを表示する。どちらも無ければ既定のブラウザで開く。

ウインドウを閉じてもサーバーは動き続けるので、次回はすぐ開く。

## 停止

- スタートメニューの **TaskDeck を停止**
- あるいは `powershell -ExecutionPolicy Bypass -File windows\taskdeck.ps1 -Stop`

`~\.taskdeck\server.pid` に記録した PID のプロセス (と子プロセスの claude) を止める。
`npm run ui` など別の方法で起動したサーバーはこの方法では止まらない。

## Claude Code に MCP を登録

```powershell
npm run mcp:register
```

`claude` が見つからない場合は、貼り付け用のコマンドと
`claude_desktop_config.json` / Codex `config.toml` の設定例を表示する。

## 環境変数

- `TASKDECK_NODE` — 使う node.exe のフルパス (自動検出をスキップ)
- `TASKDECK_PORT` — ポート (既定 4747)
- `TASKDECK_DIR` — DB / pid / ログの保存先 (既定 `%USERPROFILE%\.taskdeck`)
- `TASKDECK_CLAUDE` — claude CLI のパス (`claude.cmd` / `claude.exe`)
- `TASKDECK_REPO_ROOTS` — リポジトリ推測の探索先。Windows では **セミコロン区切り** (`C:\dev;C:\src`)

ログ: `%USERPROFILE%\.taskdeck\server.log` / `server.err.log`

## 制限

- ショートカット起動はコンソール無しで動くため、エラーはメッセージボックスで表示する
- macOS 版と違い、ウインドウを閉じてもサーバーは終了しない (明示的に停止する)
- アンインストール (ショートカットの削除のみ): `windows\install.ps1 -Uninstall`
