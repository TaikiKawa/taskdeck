# TaskDeck プロモ動画 — 撮影ショットリスト

台本は `docs/promo/script.md`。ここでは「何を、どう用意して、どう撮るか」だけ書く。

---

## 0. 共通の準備

### 画面サイズ・ブラウザ

- 収録解像度: **1280x800**（動画は 1920x1200 or 1920x1080 に拡大して書き出す。UI の文字が小さすぎないのでこのサイズ推奨）
- ブラウザ: Chrome の **アプリモード**（タブバー・URL バーが消えてボードだけになる）

```bash
open -na "Google Chrome" --args --app=http://localhost:4747 --window-size=1280,800 --window-position=100,100
```

- Windows で撮る場合:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:4747 --window-size=1280,800
```

- macOS のネイティブアプリ（`open taskdeck.app`）でもよいが、ウインドウサイズが揃えにくいので Chrome アプリモード推奨
- テーマ: OS のライト / ダークどちらでも可（`prefers-color-scheme` に追従する）。**全ショットで統一すること**。社内向けならダークが Claude Code のターミナルと並べたとき馴染みやすい
- 収録ツール: macOS は QuickTime（画面収録）or CleanShot X、Windows は Xbox Game Bar（Win+G）or OBS。カーソルは表示 ON
- 収録前に `⌘R` でリロードして、トーストや選択状態を消す

### デモ用 DB（本番の `~/.taskdeck` を汚さない）

`TASKDECK_DIR` を切り替えると別 DB になる。**UI サーバーと MCP サーバーの両方**に同じ値を渡すこと。

```bash
# UI サーバー
TASKDECK_DIR=~/.taskdeck-demo npm run ui

# Claude Code 側の MCP 登録（撮影用にデモ DB を向ける。撮影後は元に戻す）
claude mcp remove taskdeck
claude mcp add --scope user -e TASKDECK_DIR=$HOME/.taskdeck-demo taskdeck -- node /Users/taiki/dev/taskdeck/src/mcp.js
```

撮影後は `rm -rf ~/.taskdeck-demo` と、`claude mcp add` を本番の値で登録し直す（または `npm run mcp:register`）。

### デモデータ（社内向けの親しみやすい架空タスク）

グループは 3 つ: `alche-lp`（会社サイト）、`slack-bot`（社内 Bot）、`inbox`（デフォルト）。

| # | タイトル | グループ | 優先度 | 列 | メモ（任意） |
|---|---|---|---|---|---|
| 1 | LP のヒーロー画像を差し替え | alche-lp | 高 | Todo | 新しいキービジュアルは Figma の「LP 2026-09」フレーム |
| 2 | お問い合わせフォームの送信後に完了メッセージを出す | alche-lp | 中 | Todo | 今は送信しても何も出ないので不安になる |
| 3 | Slack Bot のエラーハンドリング追加 | slack-bot | 高 | Todo | 429 のときにリトライせず落ちる |
| 4 | 依存パッケージの脆弱性チェック | slack-bot | 中 | Todo | `npm audit` の high 以上を潰す |
| 5 | 週報テンプレートを Notion に移す | inbox | 低 | Todo | |
| 6 | OGP 画像が古いので差し替え | alche-lp | 低 | Doing | |
| 7 | README のセットアップ手順を Windows 対応にする | inbox | 中 | Done | |
| 8 | Bot の起動時ログにバージョンを出す | slack-bot | なし | Done | |

- タスク番号は投入順に `#1` から振られる。**上の順番どおりに入れる**と台本の番号と合う
- シーン 2 で Claude が追加するタスクは `#9〜#11`、シーン 3〜4 で 🤖 に渡すのは `#10`、シーン 4 の「#12 やって」用に、撮影直前にもう 1 枚 `#12 フッターの著作権年を 2026 に更新`（alche-lp, 低）を手で追加しておく

一括投入スクリプト（UI サーバー起動後に実行。`curl` で `POST /api/tasks`）:

```bash
add() { curl -s -X POST localhost:4747/api/tasks -H 'content-type: application/json' -d "$1" >/dev/null; }
add '{"title":"LP のヒーロー画像を差し替え","project":"alche-lp","priority":"high","notes":"新しいキービジュアルは Figma の「LP 2026-09」フレーム"}'
add '{"title":"お問い合わせフォームの送信後に完了メッセージを出す","project":"alche-lp","priority":"medium","notes":"今は送信しても何も出ないので不安になる"}'
add '{"title":"Slack Bot のエラーハンドリング追加","project":"slack-bot","priority":"high","notes":"429 のときにリトライせず落ちる"}'
add '{"title":"依存パッケージの脆弱性チェック","project":"slack-bot","priority":"medium","notes":"npm audit の high 以上を潰す"}'
add '{"title":"週報テンプレートを Notion に移す","project":"inbox","priority":"low"}'
add '{"title":"OGP 画像が古いので差し替え","project":"alche-lp","priority":"low","status":"doing"}'
add '{"title":"README のセットアップ手順を Windows 対応にする","project":"inbox","priority":"medium","status":"done"}'
add '{"title":"Bot の起動時ログにバージョンを出す","project":"slack-bot","status":"done"}'
```

（`POST /api/tasks` は `title` / `notes` / `project` / `status` / `priority` をそのまま受け付ける。`status` は `todo|doing|done`、`priority` は `high|medium|low` または空）

### 作業ディレクトリの自動入力を成立させる

シーン 3 で「作業ディレクトリが最初から埋まっている」を見せるには、**シーン 2 を先に本番で撮る**（Claude が `task_add` した時点で cwd が `~/.taskdeck-demo/projects.json` に紐付く）。順番を変える場合は、撮影前に一度 🤖 ダイアログでパスを入力して `キャンセル` せず実行 → `⏹ 停止` しておけば保存される。

### 撮影する順番（推奨）

1. 02_（シーン 2）を先に撮る → `#9〜#11` が増える
2. `#12` を手で追加
3. 03_ → 04_ を連続で撮る（🤖 実行 → Doing → Done を 1 テイクで）
4. 01_ / 06_ の全景（Done が溜まった状態のほうが絵になる）
5. 00_ の空ボード（最後に DB を空にして撮る）
6. 05_ のターミナル

---

## 1. ショット一覧

### 00_hook_empty_board.png（静止画）

- **用途**: シーン 0 の後半。空のボードにロゴだけ
- **準備**: `TASKDECK_DIR=~/.taskdeck-demo-empty npm run ui` で空 DB を立てる（または撮影の最後に全カード削除）
- **撮影**: アプリモードで開き、プロジェクトセレクタが「すべて (0)」、3 列とも空、入力欄の placeholder「タスクを追加（先頭に #プロジェクト名 でグループ指定）」が見える状態でスクショ
- **代替**: 静止画で OK（Ken Burns で `taskdeck` ロゴにゆっくり寄る）

### 01_board_overview.png（静止画）＋ 01b_board_and_terminal.mp4（動画・任意）

- **用途**: シーン 1 の全景 → ターミナル 2 分割
- **準備**: デモデータ 8 件（+ できれば 02 撮影後の `#9〜#11` も）、プロジェクトセレクタ「すべて」、並び順「手動順」
- **撮影**:
  1. 全景スクショ（`Todo` 5 枚以上、`Doing` 1 枚、`Done` 2 枚）
  2. 任意: ウインドウを左半分（640x800）にリサイズし、右半分にターミナル（`claude` 起動済み、プロンプト待機）を並べた状態を 5 秒録画。台本の「Claude も見ている」でこの 2 分割に切り替える
- **代替**: 01b はスクショ 2 枚（ボード / ターミナル）を編集で横並びにしてスライドインさせれば動画不要

### 02_claude_adds_tasks.mp4（動画）★ハイライト

- **用途**: シーン 2。Claude が `task_add` → ボードに勝手にカードが増える
- **準備**:
  - 左: アプリモードのボード（640x800 か、1280x800 のまま右にターミナルを重ねる）。プロジェクトセレクタで `alche-lp` に絞り込み
  - 右: ターミナルで `cd ~/dev/alche-lp`（会社サイトのリポジトリ。無ければ小さなダミーリポジトリを作る。**わざと** alt 属性の無い `<img>`、未使用 CSS、バリデーション無しのフォームを仕込んでおくと Claude が見つけやすい）→ `claude` 起動
  - リポジトリの `CLAUDE.md` に README の「エージェントに使わせる」節を貼っておく（project 名に `alche-lp` を使うよう明記）
- **撮影**:
  1. 録画開始。ターミナルで 1〜2 往復、普通の会話をしておく（例: 「フォームの送信処理の diff 見せて」）
  2. 入力: `ついでに、このリポジトリ見て、直したほうがいいところを 3 つくらい TaskDeck に積んでおいて。project は alche-lp で`
  3. Claude が `taskdeck - task_add` を呼ぶ → **左のボードにカードが増える**（この間マウスはターミナル側に置いたまま。ボードは触らない）
  4. 2 秒待ってから、増えたカードを 1 枚クリック → 詳細パネルの「メモ」を 3 秒見せる → `✕` で閉じる
- **注意**: Claude の出力内容は毎回変わる。タイトルが長すぎ / 数が多すぎたら撮り直す。「3 つくらい」と数を指定しておくと安定する
- **代替（確実に撮りたい場合）**: ターミナル側は本物の Claude セッションを流しつつ、カード追加だけ別ターミナルから `curl` で叩く。SSE で同じように画面が自動更新される

  ```bash
  curl -s -X POST localhost:4747/api/tasks -H 'content-type: application/json' \
    -d '{"title":"画像の alt 属性が抜けている箇所を修正","project":"alche-lp","priority":"medium","notes":"src/pages/index.html の hero / gallery セクション。スクリーンリーダー対応"}'
  ```

  ただし `curl` 経由だと「登録元セッション」と「作業ディレクトリ」が紐付かないので、シーン 3 の自動入力は別途仕込む（上記「作業ディレクトリの自動入力を成立させる」）。

### 03_dispatch_modal.mp4（動画）＋ 03b_dispatch_modal.png（静止画）

- **用途**: シーン 3。🤖 → ダイアログ → 実行 → `🤖 実行中`
- **準備**: ボード全画面（1280x800）。`#10` のカードが `Todo` にあり、`~/.taskdeck-demo/projects.json` に `alche-lp` のパスが登録済み。ターミナルで `claude /login` 済み（バックグラウンド実行に必要）。`claude` CLI が PATH に無いときは `TASKDECK_CLAUDE=/path/to/claude` を UI サーバーに渡す
- **撮影**:
  1. `#10 お問い合わせフォーム…` ではなく、02 で増えた `#10`（例: フォームのバリデーション…）にホバー → 右下 `🤖` をゆっくりクリック
  2. ダイアログ「🤖 Claude Codeに依頼」が開いたら **2 秒静止**（ここで 03b のスクショも撮る）。確認ポイント: `実行先` = 「デスクトップアプリで開く — Claude Code」、`実行モード` = 「登録元セッションの続きで実行（文脈を引き継ぐ）」、`作業ディレクトリ` にパスが入っている、`権限モード` = 「安全 — ファイル編集のみ自動許可 (acceptEdits)」
  3. `実行先` を「バックグラウンドで実行 — claude CLI」に変更（下のヒント文が変わるのを見せる）
  4. `▶ 実行` をクリック
  5. カードが `Doing` に移動し、`🤖 実行中` チップと `⏹` が出るのを 3 秒見せる
- **代替**: ダイアログは静止画 03b でも成立する（Ken Burns で `作業ディレクトリ` 欄に寄る）。ただし 5 の「実行中」チップは動画推奨。どうしても無理なら「実行中チップ付きカード」のスクショ + ズーム

### 04_progress_auto.mp4（動画）

- **用途**: シーン 4。Doing → Done の自動移動、実行ログ、`#12` で依頼
- **準備**: 03 の続き（同じテイクで OK）。タスク `#12` を `Todo` に用意しておく
- **撮影**:
  1. 03 の 5 からそのまま録画を続ける。Claude が完了すると **カードが `Done` へ自動移動**し、チップが `🤖 完了` になる（実時間で 1〜5 分。編集で早送り）
  2. `Done` に移ったカードをクリック → 詳細パネルを開き、メモ末尾の `✅ Claude実行ログ (日時)` の見出しと本文までスクロール → 3 秒静止
  3. `✕` でパネルを閉じる
  4. ターミナルを画面右に出し、`#12 のタスクやって` と入力 → Claude が `task_list` / `task_update` を呼んで `#12` が `Doing` に動くまで（動かなくても「#12 のタスクやって」と打つところまで撮れていればよい）
- **注意**: タスク完了時のカード移動は **Claude 側が `task_done` を呼ぶ**ことで起きる（ヘッドレス実行のプロンプトにその指示が入っている）。MCP がデモ DB を向いていることを再確認
- **代替**: 1 は「Doing にあるスクショ」「Done にあるスクショ」の 2 枚をクロスディゾルブでつなげば動画不要。2 の実行ログはスクショ + ズームで可

### 05_setup_terminal.mp4（動画）＋ 05b_setup_windows.png（静止画）

- **用途**: シーン 5。セットアップは 10 分
- **準備**: 別ディレクトリで clone からやり直す（`node_modules` の無い状態）。`npm run mcp:register` が実装されてから撮る
- **撮影（Mac）**:
  1. ターミナル全画面（フォント 16pt 以上、1280x800）
  2. `git clone <repo> && cd taskdeck`
  3. `npm install`（長ければ編集で早送り）
  4. `npm run mcp:register` → 登録完了の出力
  5. `npm run ui` → ブラウザに空ボードが開くまで
- **撮影（Windows）**: PowerShell で 4 を打って出力が出た状態のスクショ 1 枚（05b）。無理なら Windows ロゴ + テロップで代用
- **代替**: 全部静止画 + テロップでも成立する。コマンドはテロップで大きく出す

### 06_closing_board.png（静止画）

- **用途**: シーン 6。`Done` が溜まった全景 → 暗転
- **準備**: 04 撮影後の状態（`Done` に 4〜5 枚）。プロジェクトセレクタ「すべて」、パネルは閉じる
- **撮影**: 全景スクショ。ついでに並び順を「優先度順」に切り替えたスクショも 1 枚（使わなくてもよい）
- **代替**: 静止画で OK

---

## 2. ターミナルショットの詳細（02 / 04 / 05 共通）

- ターミナル: iTerm2 or Terminal.app（Windows は Windows Terminal）。フォント 15〜16pt、背景はボードのテーマに合わせる
- ウインドウ: ボードと並べるときは 640x800、単独なら 1280x800
- Claude Code の表示: `claude` 起動直後の見出しは映ってよい。MCP ツール呼び出し行（`taskdeck - task_add (MCP)` のような行）が読める大きさに
- 台本に出てくる入力文（そのまま打つ）:
  - 02: `ついでに、このリポジトリ見て、直したほうがいいところを 3 つくらい TaskDeck に積んでおいて。project は alche-lp で`
  - 04: `#12 のタスクやって`
- 撮影前に `claude` で一度 `task_list` を呼ばせて、MCP が接続できていることを確認（`/mcp` で taskdeck が connected か見る）
- 秘密情報の写り込みに注意: ホームディレクトリ名、`.env`、Slack トークン等。ダミーリポジトリで撮るのが安全

---

## 3. 静止画 + Ken Burns で代替できるショット

| ショット | 動画必須？ | 代替 |
|---|---|---|
| 00_hook_empty_board | 不要 | 静止画 + ロゴにズーム |
| 01_board_overview / 01b | 不要 | 静止画 2 枚を横並びスライドイン |
| 02_claude_adds_tasks | **必須**（この動画の核） | どうしても無理なら「追加前」「追加後」のスクショをカット割り + 効果音。ただし説得力は落ちる |
| 03_dispatch_modal | 半分 | ダイアログは静止画で可。`🤖 実行中` チップは動画推奨 |
| 04_progress_auto | 半分 | Doing / Done のスクショをディゾルブ。実行ログは静止画ズーム |
| 05_setup_terminal | 不要 | 静止画 + コマンドのテロップ |
| 06_closing_board | 不要 | 静止画 |

---

## 4. 撮影後チェック

- [ ] 全ショットでテーマ（ライト / ダーク）が揃っている
- [ ] ホームディレクトリのユーザー名・トークン類が写っていない
- [ ] `~/.taskdeck-demo` を消し、`claude mcp add`（or `npm run mcp:register`）で本番 DB に戻した
- [ ] 台本のテロップに使う文言が、撮れた画面の実際の文言と一致している（`🤖 Claude Codeに依頼` / `安全 — ファイル編集のみ自動許可 (acceptEdits)` / `🤖 実行中` / `✅ Claude実行ログ`）
