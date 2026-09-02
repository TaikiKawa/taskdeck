// Headless Chrome (CDP) capture for the TaskDeck promo.
// usage: node capture.mjs <scenario> [outDir]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SCRATCH = process.env.PROMO_DIR || new URL("../work", import.meta.url).pathname;
const BASE = "http://localhost:4848";
const PORT = 9333;
const scenario = process.argv[2] || "overview";
const OUT = process.argv[3] || join(SCRATCH, "promo", "shots");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- chrome ----
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--window-size=1280,800",
    `--user-data-dir=${join(SCRATCH, "chrome-profile")}`,
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-gpu",
    "--force-device-scale-factor=2",
    "--lang=ja-JP",
    "about:blank",
  ],
  { stdio: "ignore" }
);
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = tabs.find((t) => t.type === "page");
      if (t) return t.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("chrome did not start");
}

// ---- minimal CDP client ----
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (this.handlers.has(m.method)) {
        for (const h of this.handlers.get(m.method)) h(m.params);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, h) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(h); }
  off(method) { this.handlers.delete(method); }
  once(method) { return new Promise((r) => { const h = (p) => { this.handlers.set(method, (this.handlers.get(method) || []).filter((x) => x !== h)); r(p); }; this.on(method, h); }); }
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => (ws.onopen = r));
const cdp = new CDP(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

// ---- helpers ----
const evalJs = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
async function goto(path = "/") {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: BASE + path });
  await loaded; await sleep(600);
  await injectCursor();
}
async function api(path, method = "GET", body) {
  return evalJs(`fetch(${JSON.stringify(path)}, {method:${JSON.stringify(method)}, headers:{'content-type':'application/json'}, body:${body ? JSON.stringify(JSON.stringify(body)) : "undefined"}}).then(r=>r.text()).then(t=>t?JSON.parse(t):null)`);
}
async function rect(sel) {
  const r = await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2,w:b.width,h:b.height};})()`);
  if (!r) throw new Error("no element: " + sel);
  return r;
}
// fake cursor (a static arrow drawn as a background image) so the viewer sees where the click happens
const CURSOR_SVG = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18 L12 28 L16 26 L12 17 L20 17 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>'
);
let cur = { x: 640, y: 400 };
async function injectCursor() {
  await evalJs(`(()=>{ if(document.getElementById('__cur')) return; const d=document.createElement('div'); d.id='__cur';
    Object.assign(d.style,{position:'fixed',left:'${cur.x}px',top:'${cur.y}px',width:'22px',height:'30px',zIndex:'99999',pointerEvents:'none',
      backgroundImage:'url("${CURSOR_SVG}")',backgroundRepeat:'no-repeat',filter:'drop-shadow(0 1px 2px rgba(0,0,0,.6))'});
    document.body.appendChild(d); })()`);
}
async function moveTo(x, y, ms = 500) {
  const steps = Math.max(2, Math.round(ms / 25));
  const sx = cur.x, sy = cur.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = 1 - Math.pow(1 - t, 3);
    cur = { x: sx + (x - sx) * e, y: sy + (y - sy) * e };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cur.x, y: cur.y });
    await evalJs(`(()=>{const d=document.getElementById('__cur'); if(d){d.style.left='${cur.x}px';d.style.top='${cur.y}px';}})()`);
    await sleep(25);
  }
}
async function hover(sel, ms = 500, dx = 0, dy = 0) { const r = await rect(sel); await moveTo(r.x + dx, r.y + dy, ms); }
async function click(sel, ms = 500, dx = 0, dy = 0) {
  await hover(sel, ms, dx, dy);
  await sleep(120);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cur.x, y: cur.y, button: "left", clickCount: 1 });
  await sleep(70);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cur.x, y: cur.y, button: "left", clickCount: 1 });
}
let castMarks = null, castT0 = 0;
async function shot(name) {
  if (castMarks) castMarks[name] = +(Date.now() / 1000 - castT0).toFixed(2);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name + ".png"), Buffer.from(data, "base64"));
  console.log("shot", name);
}
// screencast → frames dir + concat list with real durations
async function screencast(name, fn) {
  const dir = join(OUT, name); mkdirSync(dir, { recursive: true });
  const frames = []; let n = 0;
  cdp.on("Page.screencastFrame", async (p) => {
    const f = `f${String(n++).padStart(5, "0")}.png`;
    writeFileSync(join(dir, f), Buffer.from(p.data, "base64"));
    frames.push({ f, t: p.metadata.timestamp });
    try { await cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }); } catch {}
  });
  await cdp.send("Page.startScreencast", { format: "png", quality: 100, everyNthFrame: 1 });
  const t0 = Date.now() / 1000; castMarks = {}; castT0 = t0;
  await fn();
  const t1 = Date.now() / 1000;
  writeFileSync(join(dir, "marks.json"), JSON.stringify({ ...castMarks, end: +(t1 - t0).toFixed(2) }, null, 2)); castMarks = null;
  await cdp.send("Page.stopScreencast"); cdp.off("Page.screencastFrame");
  await sleep(300);
  // concat demuxer list: each frame lasts until the next one; last frame until t1
  let list = "";
  for (let i = 0; i < frames.length; i++) {
    const d = (i + 1 < frames.length ? frames[i + 1].t : t1) - frames[i].t;
    list += `file '${frames[i].f}'\nduration ${Math.max(0.02, d).toFixed(3)}\n`;
  }
  if (frames.length) list += `file '${frames[frames.length - 1].f}'\n`;
  writeFileSync(join(dir, "frames.txt"), list);
  console.log("screencast", name, frames.length, "frames", (t1 - t0).toFixed(1), "s");
}
const setSelect = (id, value) => evalJs(`(()=>{const s=document.getElementById(${JSON.stringify(id)}); s.value=${JSON.stringify(value)}; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value;})()`);
const card = (id) => `.card[data-id="${id}"]`;

// ---- scenarios ----
const S = {
  async overview() {
    await goto("/");
    await moveTo(1100, 700, 10);
    await shot("01_board_overview");
    await setSelect("sortMode", "priority"); await sleep(400);
    await shot("01c_board_priority_sort");
    await setSelect("sortMode", "manual");
  },
  // Scene 2: cards appear while nobody touches the browser, then open one card
  async adds() {
    await goto("/");
    await setSelect("projectFilter", "example-site"); await sleep(400);
    await moveTo(1180, 760, 10);
    await shot("02a_before_adds");
    const newTasks = [
      { title: "画像の alt 属性が抜けている箇所を修正", project: "example-site", priority: "medium", notes: "src/pages/index.html の hero / gallery セクション。スクリーンリーダー対応" },
      { title: "フォームのバリデーションエラー表示を追加", project: "example-site", priority: "high", notes: "src/components/ContactForm.tsx。必須項目とメール形式のチェック、エラー文を入力欄の下に表示" },
      { title: "未使用の CSS を削除", project: "example-site", priority: "low", notes: "src/styles/legacy.css は参照されていない。PurgeCSS のレポートも添付" },
    ];
    const ids = [];
    await screencast("02_claude_adds_tasks", async () => {
      await sleep(1500);
      for (const t of newTasks) { const r = await api("/api/tasks", "POST", t); ids.push(r.id); await sleep(1800); }
      await sleep(800);
      await shot("02b_after_adds");
      await click(card(ids[1]) + " .notes", 900);
      await sleep(1500);
      await shot("02c_task_panel");
      await sleep(800);
    });
    console.log("added ids", ids);
    await click("#panelClose", 300); await sleep(300);
    // #12 for scene 4
    const r = await api("/api/tasks", "POST", { title: "フッターの著作権年を 2026 に更新", project: "example-site", priority: "low" });
    console.log("added #", r.id);
  },
  // Scene 3+4: hover → 🤖 → dialog → run → 実行中 → Done → log
  async dispatch() {
    await goto("/");
    const id = Number(process.env.DISPATCH_ID || 10);
    const cwdReal = "/tmp/claude/dev/example-site";
    await setSelect("projectFilter", "example-site"); await sleep(400);
    await evalJs(`document.querySelector('${card(id)}').scrollIntoView({block:'center'})`); await sleep(300);
    await moveTo(1150, 720, 10);
    await screencast("03_dispatch", async () => {
      await sleep(800);
      await hover(card(id) + " .title", 900);
      await sleep(900);
      // the 🤖 button is the first icon-btn inside .meta
      await click(card(id) + " .meta .icon-btn", 700);
      await sleep(900);
      await evalJs(`document.getElementById('dispatchCwd').value = '~/dev/example-site'`);
      await shot("03b_dispatch_modal");
      await sleep(1200);
      await hover("#dispatchTarget", 600); await sleep(300);
      await setSelect("dispatchTarget", "headless"); await sleep(1200);
      await shot("03c_dispatch_modal_headless");
      await evalJs(`document.getElementById('dispatchCwd').value = '${cwdReal}'`);
      await click("#dispatchForm button.primary", 700);
      await sleep(1500);
      await moveTo(1150, 720, 400);
      await sleep(800);
      await shot("03d_running");
      // wait for fake claude to finish (task → done, chip → 完了)
      for (let i = 0; i < 60; i++) {
        const t = await api(`/api/tasks`);
        const me = t.find((x) => x.id === id);
        if (me && me.status === "done") break;
        await sleep(500);
      }
      await sleep(1200);
      await shot("04a_done");
      await hover(card(id) + " .notes", 900);
      await sleep(200);
      await evalJs(`document.querySelector('${card(id)}').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
      await sleep(1200);
      await evalJs(`(()=>{const n=document.getElementById('notesEditor'); n.scrollTop=n.scrollHeight; const p=document.querySelector('#panel .panel-body'); if(p) p.scrollTop=p.scrollHeight;})()`);
      await sleep(600);
      await shot("04b_run_log");
      await sleep(1200);
    });
    await click("#panelClose", 300);
  },
  async closing() {
    await goto("/");
    await moveTo(1180, 760, 10);
    await shot("06_closing_board");
  },
  async empty() {
    await goto("/");
    const t = await api("/api/tasks");
    for (const x of t) await api(`/api/tasks/${x.id}`, "DELETE");
    await goto("/");
    await moveTo(1180, 760, 10);
    await shot("00_hook_empty_board");
  },
  async terminal() {
    // static mock of a Claude Code session (avoids leaking anything real); page is served from file
    const file = process.env.TERM_HTML;
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: "file://" + file });
    await loaded; await sleep(500);
    await shot(process.env.TERM_NAME || "terminal");
  },
};

try {
  await S[scenario]();
} finally {
  ws.close(); chrome.kill("SIGKILL");
}
