// Minimal Chrome DevTools Protocol driver, no dependencies. Shared by qa-browser.mjs and smoke-deployed.mjs.
// Needs Node 22+ (global WebSocket) and a Chromium/Chrome binary: set CHROME_BIN, or it looks for a
// Playwright-installed chrome-headless-shell / chrome under ~/.cache/ms-playwright.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const pw = path.join(os.homedir(), ".cache", "ms-playwright");
  if (existsSync(pw)) {
    for (const dir of readdirSync(pw).sort().reverse()) {
      for (const rel of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const p = path.join(pw, dir, rel);
        if (dir.startsWith("chromium") && existsSync(p)) return p;
      }
    }
  }
  throw new Error("No Chromium found. Set CHROME_BIN=/path/to/chrome.");
}

// Starts a fresh Chromium (new profile, so no cookies or storage) at phone width and returns a small driver.
// `logs` collects console errors/warnings, uncaught exceptions and browser log entries (CSP, CORS, network).
export async function launchChrome(port = 9400 + Math.floor(Math.random() * 5000)) {
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
  const handlers = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (handlers.has(msg.method)) handlers.get(msg.method)(msg.params);
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
    on: (method, fn) => handlers.set(method, fn),
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, ms = 5000) {
      for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) if (await b.eval(expr)) return;
      throw new Error(`timeout waiting for ${expr}`);
    },
    async goto(url, ready = "true", ms = 15000) {
      await send("Page.navigate", { url });
      await sleep(300);
      await b.waitFor(`document.readyState==='complete' && (${ready})`, ms);
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
