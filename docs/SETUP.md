# TaskDeck セットアップガイド

自分の PC の中だけで動く、人間と Claude が同じボードを共有するカンバンです。
このガイドは「TaskDeck を初めて触る人」向けに、インストールから Claude との接続、最初の5分の使い方までを順番に説明します。
所要時間はだいたい 10 分です。

> **先に知っておいてほしいこと**
> - **完全ローカル**です。データはあなたの PC の中（`~/.taskdeck/tasks.db`）にしか保存されません。クラウドには送られません。
> - **1人1ボード**です。同僚のボードと自動同期されるものではありません（「自分の頭の中の ToDo を Claude と共有する」ためのツールです）。
> - Mac / Windows どちらでも動きます。
> - **Node.js や git を入れたくない人へ**: [GitHub Releases](https://github.com/TaikiKawa/taskdeck/releases) に Node.js 同梱のビルド済み版があります。
>   その場合は 2〜4 章は不要で、下の「0. ビルド済み版を使う」だけで動きます。

---

## 0. ビルド済み版を使う（Node.js 不要）

Releases から自分の OS の zip をダウンロードします。

| ファイル | 対象 |
|---|---|
| `taskdeck-<バージョン>-mac-universal.zip` | macOS 13 以降（Apple Silicon / Intel 両対応） |
| `taskdeck-<バージョン>-win-x64.zip` | Windows 10 / 11（64bit） |

**Mac**

1. zip を展開し、`taskdeck.app` を「アプリケーション」フォルダに移動して開く
2. 「開発元を確認できない」と出たら、Finder で `taskdeck.app` を右クリック → 「開く」（初回だけ）
3. メニューバーの **Claude → Claude Code に MCP を登録…** を選ぶ。`claude` コマンドが入っていればその場で登録され、無ければ登録コマンドがクリップボードにコピーされるのでターミナルに貼り付けて実行する

**Windows**

1. zip を展開し、フォルダごと好きな場所に置く（例: `C:\Users\あなた\TaskDeck`）
2. そのフォルダで PowerShell を開き、次を実行する

```powershell
powershell -ExecutionPolicy Bypass -File windows\install.ps1
```

3. デスクトップに「TaskDeck」ショートカットができるのでダブルクリックで起動。`claude` コマンドが入っていれば MCP も同時に登録される

ビルド済み版を使う場合、このあとは [6. CLAUDE.md への追記](#6-claudemd-への追記) と [7. 最初の5分でやってみること](#7-最初の5分でやってみること) に進んでください。
アプリを別の場所に移動したら MCP の登録パスがずれるので、もう一度登録し直してください。

---

## 目次

1. [TaskDeck でできること](#1-taskdeck-でできること)
2. [前提（インストールしておくもの）](#2-前提インストールしておくもの)
3. [Mac セットアップ](#3-mac-セットアップ)
4. [Windows セットアップ](#4-windows-セットアップ)
5. [Claude との接続（MCP 登録）](#5-claude-との接続mcp-登録)
6. [CLAUDE.md への追記](#6-claudemd-への追記)
7. [最初の5分でやってみること](#7-最初の5分でやってみること)
8. [トラブルシュート](#8-トラブルシュート)
9. [データの場所とバックアップ](#9-データの場所とバックアップ)
10. [環境変数一覧](#10-環境変数一覧)

---

## 1. TaskDeck でできること

- **Todo / Doing / Done の3列カンバン**。カードはドラッグ＆ドロップで動かせて、`#プロジェクト名` でグループ分けできる
- **Claude がボードを直接読み書きする**。「今日やること3つ登録して」と言えばカードが勝手に増え、作業中の Claude が「これも後でやったほうがいい」と気づいたことをボードに残してくれる
- **カードの 🤖 ボタン1つで、そのタスクを Claude に丸投げできる**。Claude デスクトップアプリに新規セッションとして開くか、claude CLI でバックグラウンド実行するかを選べる
- Claude が着手すると Doing、終わると Done にカードが勝手に動き、実行ログがカードのメモに残る

**MCP とは？** Claude がボードを直接読み書きするための「差し込み口」です。TaskDeck には小さな MCP サーバー（`src/mcp.js`）が同梱されていて、これを Claude Code / Claude デスクトップアプリ / Codex に登録すると、Claude が `task_add`（追加）・`task_list`（一覧）・`task_update`（状態変更）・`task_done`（完了）などのツールを使えるようになります。

---

## 2. 前提（インストールしておくもの）

| 必要なもの | 用途 | 必須？ |
|---|---|---|
| **Node.js 22**（20 以上なら動作） | サーバー本体と MCP サーバーの実行 | 必須 |
| **git** | リポジトリの取得・更新 | 必須 |
| **Claude Code CLI** または **Claude デスクトップアプリ** | Claude との接続先 | どちらか片方で OK |

Claude 側は **CLI とデスクトップアプリのどちらか片方があれば動きます**。
ただし CLI（`claude` コマンド）が無い場合、🤖 ボタンの「**バックグラウンドで実行 — claude CLI**」だけは使えません（「デスクトップアプリで開く」は使えます）。両方入っているのが一番快適です。

### Node.js のインストール

**Mac（Homebrew）**

```bash
brew install node@22
brew link --overwrite node@22
node -v   # v22.x.x と出れば OK
```

**Mac（nodebrew を使っている人）**

```bash
nodebrew install v22
nodebrew use v22
node -v
```

**Windows**

1. https://nodejs.org/ から **LTS（22.x）** の Windows インストーラ（.msi）をダウンロードして実行
2. インストール中に「Tools for Native Modules」のチェックが出たら **ON にしておく**と、あとで `npm install` がこけにくくなります
3. PowerShell を開き直して確認:

```powershell
node -v   # v22.x.x と出れば OK
```

### git のインストール

- **Mac**: `git --version` を実行。入っていなければダイアログが出るので「インストール」（Xcode Command Line Tools）。または `brew install git`
- **Windows**: https://git-scm.com/download/win からインストーラを実行（設定は全部デフォルトで OK）

### Claude Code CLI / Claude デスクトップアプリ

- **Claude Code CLI**: すでに使っている人はそのままで OK。未インストールなら `npm install -g @anthropic-ai/claude-code` のあと `claude` を起動してログイン
- **Claude デスクトップアプリ**: https://claude.ai/download からインストールしてログイン

---

## 3. Mac セットアップ

### 3-1. リポジトリを取得

置き場所は `~/dev/taskdeck` を推奨します（TaskDeck が `~/dev` 配下のリポジトリを自動で探してくれるため）。

```bash
mkdir -p ~/dev && cd ~/dev
git clone https://github.com/TaikiKawa/taskdeck.git
cd taskdeck
```

### 3-2. インストールしてアプリをビルド

```bash
npm install && ./macos/build.sh && open taskdeck.app
```

- `./macos/build.sh` はリポジトリ直下に `taskdeck.app` を作ります。初回は Swift のコンパイルが走るので少し待ちます
- `swiftc` が無いと言われたら `xcode-select --install` で Command Line Tools を入れてから再実行してください

`open taskdeck.app` でウインドウが開けば完了です。

- アプリを起動すると、裏でサーバー（`src/server.js`）が自動で立ち上がります
- Cmd+Q で終了するとサーバーも一緒に止まります
- Dock に入れておけば普通の Mac アプリとして使えます（Cmd+R で再読み込み）
- Node.js の場所は nodebrew / Homebrew / ログインシェルの PATH から自動検出されます

### 3-3. ブラウザで使いたい場合（アプリを使わない）

```bash
cd ~/dev/taskdeck
npm run ui
# → http://localhost:4747 をブラウザで開く
```

ターミナルを閉じると止まります。普段使いにはアプリの方が楽です。

---

## 4. Windows セットアップ

コマンドはすべて **PowerShell**（スタートメニューで「PowerShell」を検索）で実行します。

### 4-1. リポジトリを取得

置き場所は `%USERPROFILE%\dev\taskdeck`（例: `C:\Users\あなた\dev\taskdeck`）を推奨します。

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\dev" | Out-Null
Set-Location "$env:USERPROFILE\dev"
git clone https://github.com/TaikiKawa/taskdeck.git
Set-Location taskdeck
```

### 4-2. スクリプト実行を一度だけ許可

Windows は初期状態だと `.ps1` スクリプトを実行できません。**最初の1回だけ**次を実行します（管理者権限は不要）。

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 4-3. インストーラを実行

```powershell
.\windows\install.ps1
```

このスクリプトがやること:

- Node.js（20 以上）と git が入っているかチェック
- `npm install`（依存パッケージの取得）
- デスクトップとスタートメニューに **「TaskDeck」** のショートカットを作成

### 4-4. 起動する

デスクトップの **TaskDeck** ショートカットをダブルクリックすると、サーバーが起動してアプリ風のウインドウ（Edge / Chrome のアプリモード）でボードが開きます。

PowerShell から起動したい場合:

```powershell
.\windows\taskdeck.ps1          # 起動
.\windows\taskdeck.ps1 -Stop    # サーバーを停止
```

（`windows\taskdeck.vbs` をダブルクリックしても同じように起動できます）

ブラウザで直接使いたい場合は Mac と同じく `npm run ui` → http://localhost:4747 です。

---

## 5. Claude との接続（MCP 登録）

ここまでで「人間がボードを使う」準備はできました。次に **Claude がボードを読み書きできるように** MCP を登録します。
使っている Claude に合わせて (a)〜(d) のうち該当するものを設定してください（複数登録して OK です）。

### (a) Claude Code CLI

リポジトリの中で次を実行するだけです（Mac / Windows 共通）。

```bash
npm run mcp:register
```

内部では `claude mcp add --scope user taskdeck -- node <リポジトリの絶対パス>/src/mcp.js` が実行されます。`--scope user` なので **どのフォルダで Claude Code を開いても** taskdeck が使えます。

登録できたか確認:

```bash
claude mcp list
# taskdeck: node /Users/.../taskdeck/src/mcp.js - ✓ Connected  のように出れば OK
```

`claude` コマンドが見つからない環境で `npm run mcp:register` を実行すると、代わりに **登録コマンドと、(b)(d) 用の設定スニペット（あなたの環境の絶対パス入り）を表示**してくれます。表示だけしたいときは:

```bash
npm run mcp:register -- --print
```

### (b) Claude デスクトップアプリ

Claude デスクトップアプリは設定ファイル `claude_desktop_config.json` で MCP を管理します。
アプリの「設定 → 開発者（Developer）」あたりに設定ファイルを開くボタンがありますが、場所は次のとおりです。

| OS | 場所 |
|---|---|
| Mac | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

ファイルが無ければ新規作成してください。

**Mac の例**（`you` の部分は自分のユーザー名に）:

```json
{
  "mcpServers": {
    "taskdeck": {
      "command": "node",
      "args": ["/Users/you/dev/taskdeck/src/mcp.js"]
    }
  }
}
```

**Windows の例**（パスの区切りは `\\` と2つ重ねる）:

```json
{
  "mcpServers": {
    "taskdeck": {
      "command": "node",
      "args": ["C:\\Users\\you\\dev\\taskdeck\\src\\mcp.js"]
    }
  }
}
```

すでに他の MCP が書かれている場合は `"mcpServers": { ... }` の中に `"taskdeck": {...}` を追加します。
保存したら **Claude デスクトップアプリを完全に終了して起動し直す**と反映されます（Mac は Cmd+Q、Windows はタスクトレイのアイコンから終了）。

> `node` が見つからないと言われる場合は `"command"` を `node` の絶対パス（Mac: `which node`、Windows: `where.exe node` で確認）にしてください。

### (c) Cowork

Cowork は Claude デスクトップアプリの一部なので、**(b) で登録した MCP 設定がそのまま共有されます**。別途の登録は基本的に不要です。
もし Cowork 側で taskdeck が見えない場合は、アプリ側の MCP（コネクタ）設定画面から有効になっているか確認してください。

### (d) Codex CLI

`~/.codex/config.toml` に次を追記します（Windows は `%USERPROFILE%\.codex\config.toml`、パスは `/` 区切りでも読めます）。

```toml
[mcp_servers.taskdeck]
command = "node"
args = ["/Users/you/dev/taskdeck/src/mcp.js"]
```

### 登録後に使えるようになる MCP ツール

| ツール | 用途 |
|---|---|
| `task_add` | タスク追加（複数可、`project` でグループ指定） |
| `task_list` | 未完了タスク一覧（project/status/session で絞り込み） |
| `task_update` | ステータス変更・タイトル/メモ/プロジェクト/優先度の編集 |
| `task_done` | 完了にする（複数可） |
| `task_delete` | 削除 |
| `project_add` | 空のグループを作成 |
| `project_list` | プロジェクト一覧と件数 |

---

## 6. CLAUDE.md への追記

MCP を登録しただけだと、Claude は「使えるけど、いつ使うかは気分次第」の状態です。
**CLAUDE.md に一言書いておく**と、セッション開始時にボードを見に行き、作業中に気づいたことをボードに残してくれるようになります。

`~/.claude/CLAUDE.md` に書けば **全プロジェクト共通**で効きます（プロジェクトごとに変えたければ各リポジトリの `CLAUDE.md` へ）。

```markdown
## タスク管理
- このマシンには taskdeck MCP がある。project 名にはレポジトリ名を使うこと。
- セッション開始時に `task_list` で未完了タスクを確認する。
- 作業中に気づいた改善点・セキュリティリスク・フォローアップは、
  その場で `task_add` に登録してから作業を続ける。
- 着手したら `task_update` で status を doing に、完了したら `task_done`。
```

Mac / Linux でファイルが無い場合はこれで作れます:

```bash
mkdir -p ~/.claude
cat >> ~/.claude/CLAUDE.md <<'EOF'

## タスク管理
- このマシンには taskdeck MCP がある。project 名にはレポジトリ名を使うこと。
- セッション開始時に `task_list` で未完了タスクを確認する。
- 作業中に気づいた改善点・セキュリティリスク・フォローアップは、
  その場で `task_add` に登録してから作業を続ける。
- 着手したら `task_update` で status を doing に、完了したら `task_done`。
EOF
```

Windows（PowerShell）:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude" | Out-Null
Add-Content -Encoding utf8 "$env:USERPROFILE\.claude\CLAUDE.md" @"

## タスク管理
- このマシンには taskdeck MCP がある。project 名にはレポジトリ名を使うこと。
- セッション開始時に ``task_list`` で未完了タスクを確認する。
- 作業中に気づいた改善点・セキュリティリスク・フォローアップは、
  その場で ``task_add`` に登録してから作業を続ける。
- 着手したら ``task_update`` で status を doing に、完了したら ``task_done``。
"@
```

> エンジニア以外の人へ: この項目は「Claude Code をコードのあるフォルダで使う人」向けです。Claude デスクトップアプリで会話するだけなら、CLAUDE.md は無くても「登録して」と頼めばボードに書いてくれます。

---

## 7. 最初の5分でやってみること

1. **ボードを開く**
   Mac は `taskdeck.app`、Windows はデスクトップの TaskDeck ショートカット。Todo / Doing / Done の空の3列が出ます。

2. **手で1枚追加する**
   上の入力欄に `#taskdeck READMEを読む` と打って Enter。`#taskdeck` の部分がグループ（プロジェクト）名になり、カードが Todo に入ります。カード左上の `#1` がタスク番号です（クリックでコピー）。

3. **Claude に登録させてみる**
   Claude Code か Claude デスクトップアプリを開いて、こう言ってみてください:

   > 今日やること3つ、taskdeck に登録して

   ボードを見ていると、何も触っていないのにカードが増えます（Claude の追加は自動で画面に反映されます）。

4. **🤖 ボタンで Claude に依頼する**
   カードにマウスを乗せると 🤖 が出るのでクリック（詳細パネルの「🤖 Claudeに依頼」でも同じ）。ダイアログで:
   - **実行先**: まずは「**デスクトップアプリで開く — Claude Code**」が無難。Claude デスクトップアプリに、タスク内容が入った新規セッションが開くので、内容を確認して送信するだけです
   - **作業ディレクトリ**: そのタスクに関係するリポジトリ。`~/dev/<プロジェクト名>` にあれば自動で入ります
   - 「**バックグラウンドで実行 — claude CLI**」を選ぶと、ターミナルも何も開かず裏で全自動実行されます。このときだけ **権限モード**（**安全** = ファイル編集のみ自動許可 / **全自動** = すべて許可。信頼できるタスクのみ）と **実行モード**（新規セッション / 登録元セッションの続き）を選びます

5. **進捗が勝手に動くのを見る**
   Claude が着手するとカードが **Doing** へ、終わると **Done** へ動きます。バックグラウンド実行なら「🤖 実行中」バッジが出て、⏹ でいつでも止められます。終わると実行ログ（Claude の最終サマリ）がカードのメモに追記されます。

ここまでできれば、あとは普段どおり Claude と話すだけで「あれやらなきゃ」がボードに溜まっていきます。

**ちょっとしたコツ**

- 「#12 のタスクやって」のように **番号で頼める**
- 「＋ グループ」で空のグループを先に作っておける。タスク0件のグループは「🗑 グループ」で消せる
- 並び順は「優先度順」に切り替えられる（Todo/Doing は高→中→低、Done は完了が新しい順）

---

## 8. トラブルシュート

### ポート 4747 が使われている / 「address already in use」

別のアプリが 4747 を使っています。環境変数 `TASKDECK_PORT` で変えられます。

```bash
# Mac / ブラウザ起動
TASKDECK_PORT=4848 npm run ui

# Mac アプリ（open は環境変数を引き継がないので launchctl で設定してから起動）
launchctl setenv TASKDECK_PORT 4848
open taskdeck.app
```

```powershell
# Windows（そのセッションだけ）
$env:TASKDECK_PORT = 4848
.\windows\taskdeck.ps1

# Windows（ショートカット起動にも効かせたい場合はユーザー環境変数に保存）
[Environment]::SetEnvironmentVariable("TASKDECK_PORT", "4848", "User")
```

前回の TaskDeck が残っているだけのこともあります。Windows なら `.\windows\taskdeck.ps1 -Stop`、Mac なら `lsof -i :4747` で PID を調べて `kill` してください。

### 🤖 → バックグラウンド実行で「claude CLI が見つかりません」

アプリから起動したサーバーは素の PATH しか持たないため、`claude` の場所を自動検出できないことがあります。`TASKDECK_CLAUDE` で場所を教えてください。

```bash
which claude                      # 例: /Users/you/.nodebrew/current/bin/claude
launchctl setenv TASKDECK_CLAUDE "$(which claude)"
open taskdeck.app
```

```powershell
where.exe claude                  # 例: C:\Users\you\AppData\Roaming\npm\claude.cmd
[Environment]::SetEnvironmentVariable("TASKDECK_CLAUDE", "C:\Users\you\AppData\Roaming\npm\claude.cmd", "User")
```

そもそも CLI を入れていない場合は、実行先を「デスクトップアプリで開く」にしてください。
また、バックグラウンド実行はターミナルで `claude /login` 済みである必要があります（`claude setup-token` で作ったトークンだと切れにくいです）。

### Mac アプリが起動しない / 「Node が見つかりません」

`taskdeck.app` は nodebrew / Homebrew / ログインシェルの PATH から `node` を探します。見つからない場合は `TASKDECK_NODE` で指定します。

```bash
which node                        # 例: /opt/homebrew/bin/node
launchctl setenv TASKDECK_NODE "$(which node)"
open taskdeck.app
```

### `npm install` で better-sqlite3 のビルドに失敗する

TaskDeck は SQLite ドライバ（better-sqlite3）を使っていて、通常は **ビルド済みバイナリ（prebuilt）** が自動でダウンロードされます。失敗するのは主に次の2パターンです。

- **ネットワークの都合で prebuilt が落ちてこない**（プロキシなど）: ネットワークを変えて `npm install` をやり直す
- **prebuilt が無い Node バージョンを使っている**: Node 22（LTS）に揃える

それでもダメな場合はローカルでビルドされるため、ビルドツールが必要です。

- **Mac**: `xcode-select --install`
- **Windows**: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) をインストールし、「**C++ によるデスクトップ開発**」ワークロードにチェック。Node インストーラの「Tools for Native Modules」を ON にしていれば同等のものが入っています

そのあと `npm install` を再実行してください。

### MCP を登録したのに Claude に taskdeck が出てこない

- **Claude Code CLI**: `claude mcp list` で `taskdeck` が `Connected` になっているか確認。出てこなければ `npm run mcp:register` をやり直し。すでに開いている Claude Code セッションには反映されないので、新しいセッションを開く
- **Claude デスクトップアプリ**: JSON の構文ミス（カンマの過不足、Windows の `\` が1つ）が定番です。保存後に **アプリを完全終了して再起動**（Mac は Cmd+Q、Windows はタスクトレイから終了）。`args` のパスが実在するかも確認
- **どちらも**: `node src/mcp.js` を手で実行してすぐエラーで落ちないか確認（何も出ずに待機状態になれば正常。Ctrl+C で終了）

### 🤖 → 「デスクトップアプリで開く」で何も開かない

`claude://` リンクを受け取る **Claude デスクトップアプリがインストールされていません**。https://claude.ai/download から入れてログインしてください。アプリを入れたくない場合は「バックグラウンドで実行 — claude CLI」を使ってください。

### Windows で `.\windows\install.ps1` が「スクリプトの実行が無効」と言われる

4-2 の `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行してから、PowerShell を開き直してください。

### Claude が追加したカードがボードに出てこない

- 別のポート / 別の `TASKDECK_DIR` で動いていないか確認（MCP サーバーとボードは同じ `tasks.db` を見る必要があります）
- ブラウザで使っている場合は再読み込み

---

## 9. データの場所とバックアップ

すべて `~/.taskdeck/` の下にあります（Windows は `%USERPROFILE%\.taskdeck\`、例: `C:\Users\あなた\.taskdeck\`）。

| ファイル | 中身 |
|---|---|
| `tasks.db` | ボードの本体（SQLite 1ファイル）。**これだけコピーすればバックアップ完了** |
| `tasks.db-wal` / `tasks.db-shm` | SQLite の作業ファイル。アプリ起動中に存在することがある |
| `projects.json` | プロジェクト名 → 作業ディレクトリの対応表（🤖 依頼時に自動入力される元） |

### バックアップ

TaskDeck を終了してから `tasks.db` をコピーするのが確実です（起動中は `-wal` に未反映の書き込みが残っていることがあるため、コピーするなら3ファイルまとめて）。

```bash
# Mac
cp ~/.taskdeck/tasks.db ~/Desktop/tasks-$(date +%Y%m%d).db
```

```powershell
# Windows
Copy-Item "$env:USERPROFILE\.taskdeck\tasks.db" "$env:USERPROFILE\Desktop\tasks-$(Get-Date -Format yyyyMMdd).db"
```

### 復元

TaskDeck を終了した状態で、コピーしておいた `tasks.db` を元の場所に戻すだけです。

### 別 PC への引っ越し

新しい PC で TaskDeck をセットアップしたあと、`tasks.db` と `projects.json` をコピーします（`projects.json` のパスは新 PC に合わせて書き換えてください）。

---

## 10. 環境変数一覧

| 変数 | 意味 | デフォルト |
|---|---|---|
| `TASKDECK_PORT` | UI のポート | `4747` |
| `TASKDECK_DIR` | DB の保存先ディレクトリ | `~/.taskdeck` |
| `TASKDECK_NODE` | Mac アプリが使う `node` のパス（未設定なら自動検出） | 自動検出 |
| `TASKDECK_CLAUDE` | `claude` CLI のパス（未設定なら自動検出） | 自動検出 |
| `TASKDECK_RUN_TIMEOUT_MS` | バックグラウンド実行のタイムアウト（ミリ秒） | `1800000`（30分） |
| `TASKDECK_REPO_ROOTS` | 作業ディレクトリ推測の探索先（コロン区切り） | `~/dev:~` |

設定のしかた:

- `npm run ui` で起動するとき: `TASKDECK_PORT=4848 npm run ui` のようにコマンドの前に付ける
- Mac アプリ（`open taskdeck.app`）: `open` は環境変数を渡さないので `launchctl setenv 変数名 値` を実行してから `open`
- Windows: `$env:変数名 = 値` のあと `.\windows\taskdeck.ps1`。ショートカット起動にも効かせたい場合は `[Environment]::SetEnvironmentVariable("変数名", "値", "User")` でユーザー環境変数に保存

---

困ったら、このガイドの該当箇所を添えて GitHub の Issue で聞いてください。
アップデートは `cd ~/dev/taskdeck && git pull && npm install`（Mac はさらに `./macos/build.sh`）です。
