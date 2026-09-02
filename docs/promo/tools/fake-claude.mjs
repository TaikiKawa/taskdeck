const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString();
const id = Number((prompt.match(/id=(\d+)/) || [])[1]);
const port = process.env.TASKDECK_PORT || 4848;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
emit({ type: "system", subtype: "init", session_id: "demo" });
await sleep(Number(process.env.FAKE_CLAUDE_WAIT_MS || 8000));
emit({ type: "assistant", message: { content: [{ type: "text", text: "フォームのバリデーションを確認しています…" }] } });
await sleep(2000);
const result = [
  "お問い合わせフォームにバリデーションエラー表示を追加しました。",
  "- src/components/ContactForm.tsx: 必須項目とメール形式のチェックを追加し、エラー文を各入力欄の下に表示",
  "- src/styles/form.css: .field-error スタイルを追加",
  "- 送信ボタンはエラーがある間 disabled にしました",
  "動作確認: 空送信・不正なメール・正常送信の3パターンで想定どおりです。",
].join("\n");
if (id) {
  try {
    await fetch(`http://localhost:${port}/api/tasks/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
  } catch {}
}
emit({ type: "result", subtype: "success", is_error: false, result });
