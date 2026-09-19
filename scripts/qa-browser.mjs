// Automates spec §13 manual QA items 1-6 (plus keyboard nav) in headless Chromium, no dependencies.
// Usage: npm run qa:browser   (needs Node 22+ for the global WebSocket, and a Chromium/Chrome binary)
// Chromium: set CHROME_BIN, or it looks for a Playwright-installed chrome-headless-shell / chrome.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const pw = path.join(os.homedir(), ".cache", "ms-playwright");
  if (existsSync(pw)) {
    for (const dir of readdirSync(pw).sort().reverse()) {
      for (const rel of [`chrome-headless-shell-linux64/chrome-headless-shell`, `chrome-linux64/chrome`, `chrome-linux/chrome`]) {
        const p = path.join(pw, dir, rel);
        if (dir.startsWith("chromium") && existsSync(p)) return p;
      }
    }
  }
  throw new Error("No Chromium found. Set CHROME_BIN=/path/to/chrome.");
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const file = path.join(DOCS, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    if (!file.startsWith(DOCS) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

async function launch(port) {
  const proc = spawn(findChrome(), [`--remote-debugging-port=${port}`, "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
    if (!page) await sleep(100);
  }
  if (!page) throw new Error("Chromium did not start");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      logs.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    } else if (msg.method === "Runtime.exceptionThrown") logs.push(`EXCEPTION: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    else if (msg.method === "Log.entryAdded" && msg.params.entry.level !== "info") logs.push(`log.${msg.params.entry.level}: ${msg.params.entry.text}`);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Log.enable")]);
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 900, deviceScaleFactor: 1, mobile: true });

  const b = {
    logs,
    send,
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, ms = 5000) {
      for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) if (await b.eval(expr)) return;
      throw new Error(`timeout waiting for ${expr}`);
    },
    async goto(url) {
      await send("Page.navigate", { url });
      await sleep(300);
      await b.waitFor("document.readyState==='complete' && document.getElementById('best')?.textContent.length>0");
    },
    async click(sel) {
      const r = await b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      if (!r) throw new Error(`no element ${sel}`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
      await sleep(100);
    },
    async type(sel, text) {
      await b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select();})()`);
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      if (text) await send("Input.insertText", { text });
      await sleep(100);
    },
    async key(key) {
      const vk = { ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38 }[key];
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: vk });
      await sleep(100);
    },
    close() { try { ws.close(); } catch {} proc.kill(); },
  };
  return b;
}

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
};

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const b = await launch(9400 + Math.floor(Math.random() * 500));
const b2 = { current: null };
const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const hashParam = (k) => b.eval(`new URLSearchParams(location.hash.slice(1)).get(${JSON.stringify(k)})`);
const snapshot = (page) => page.eval(`JSON.stringify({loc: document.getElementById('loc-name').textContent, best: document.getElementById('best').textContent, windows: document.getElementById('windows').textContent, inputs: [...document.querySelectorAll('.rule input.num')].map(i=>i.value)})`);

try {
  await b.goto(base);

  const best0 = await text("#best");
  check("1. default preset renders a best window", /^Best window: \w{3} \d+ [AP]M to \d+ [AP]M \(\d+ h\)$/.test(best0), best0);

  const res0 = await b.eval("performance.getEntriesByType('resource').length");
  const r0 = await hashParam("r");
  await b.type('.rule[data-id="wind"] input[data-field="max"]', "5");
  check("2a. editing wind max re-evaluates instantly", (await text("#best")) !== best0, await text("#best"));
  check("2b. no network request during the edit", res0 === (await b.eval("performance.getEntriesByType('resource').length")));
  check("2c. URL hash updates", r0 !== (await hashParam("r")));
  await b.type('.rule[data-id="wind"] input[data-field="max"]', "25");
  check("2d. restoring the value restores result and preset", (await text("#best")) === best0 && (await b.eval("document.getElementById('preset').value")) === "preset:paint-exterior");

  await b.click(".cell.state-fail");
  const detail = await text("#detail");
  check("3. tapping a red cell shows failing rules with value vs limit", /Fails \d rules?/.test(detail) && /(mm\/h|km\/h|°C|%) [<>] |Not daylight/.test(detail), detail);

  const rBefore = await hashParam("r");
  const num = (rule, field) => b.eval(`document.querySelector('.rule[data-id="${rule}"] input[data-field="${field}"]').value`);
  const before = [await num("temp", "min"), await num("temp", "max"), await num("dew", "min"), await num("wind", "max")];
  await b.click('input[name="units"][value="imperial"]');
  const after = [await num("temp", "min"), await num("temp", "max"), await num("dew", "min"), await num("wind", "max")];
  check("4a. imperial converts displayed numbers", before.join() === "10,29,3,25" && after.join() === "50,84.2,5.4,15.5", `${before} -> ${after}`);
  check("4b. shared-link rules unchanged, units flag set", (await hashParam("r")) === rBefore && (await hashParam("u")) === "imperial");
  check("4c. result unchanged by units", (await text("#best")) === best0);
  await b.type('.rule[data-id="temp"] input[data-field="min"]', "59");
  const stored = await b.eval("JSON.parse(atob(new URLSearchParams(location.hash.slice(1)).get('r').replace(/-/g,'+').replace(/_/g,'/'))).rules[0].min");
  check("4d. typing 59 F stores 15 C", stored === 15, String(stored));
  await b.type('.rule[data-id="temp"] input[data-field="min"]', "50");
  await b.click('input[name="units"][value="metric"]');

  await b.type('.rule[data-id="wind"] input[data-field="max"]', "30");
  await b.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: new URL(base).origin }).catch(() => {});
  await b.click("#copy-link");
  const url = await b.eval("location.href");
  check("5a. Copy link reports success", /copied/i.test(await text("#action-status")), await text("#action-status"));
  const snap1 = await snapshot(b);
  const fresh = await launch(9400 + Math.floor(Math.random() * 500) + 500); // fresh profile = fresh tab with no saved state
  await fresh.goto(url);
  check("5b. link in a fresh browser shows same location, rules and result", snap1 === (await snapshot(fresh)), `${url.length} chars`);
  if (fresh.logs.length) check("5c. fresh tab has no console errors", false, fresh.logs.join(" | "));
  fresh.close();

  await b.click("#grid .cell[tabindex='0']");
  const stops = await b.eval("document.querySelectorAll('#grid .cell[tabindex=\"0\"]').length");
  await b.key("ArrowRight");
  await b.key("ArrowDown");
  check("K. grid is one tab stop and arrow keys move selection", stops === 1 && (await b.eval("document.activeElement.classList.contains('cell') && document.activeElement.getAttribute('aria-pressed')")) === "true");

  for (let n = 0; n < 10 && (await b.eval("!!document.querySelector('.rule .remove')")); n++) await b.click(".rule .remove");
  const noRules = await b.eval("(()=>{const e=document.getElementById('no-rules'); return e.hidden ? null : e.textContent.trim()})()");
  check("6a. removing all rules shows a sane message", (await b.eval("document.querySelectorAll('.rule').length")) === 0 && /every hour counts as a pass/i.test(noRules ?? ""), noRules);
  check("6b. everything passes; window is the whole forecast", /^Best window: /.test(await text("#best")) && (await b.eval("document.querySelectorAll('.cell.state-fail, .cell.state-near').length")) === 0, await text("#best"));

  check("no console errors or CSP violations", b.logs.length === 0, b.logs.join(" | "));
} catch (err) {
  failed++;
  console.log("ERROR", err.stack);
}
b.close();
server.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
