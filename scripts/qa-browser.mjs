// Automates spec §13 manual QA items 1-10 (plus keyboard nav) in headless Chromium, no dependencies.
// Open-Meteo requests are intercepted and answered from tests/fixtures (or a fake 429 / dropped connection),
// so the run is deterministic and never touches the real API. Date.now is pinned to the fixtures' capture time.
// Usage: npm run qa:browser   (needs Node 22+ for the global WebSocket, and a Chromium/Chrome binary)
// Chromium: set CHROME_BIN, or it looks for a Playwright-installed chrome-headless-shell / chrome.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const CAPTURED_AT = Date.parse(JSON.parse(readFileSync(path.join(FIXTURES, "_meta.json"), "utf8")).capturedAt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepMs = sleep;

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
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const real = Date.now.bind(Date); const t0 = real(); Date.now = () => ${CAPTURED_AT} + (real() - t0); })();`,
  });

  // Fake Open-Meteo. mock.forecast: "ok" | "offline" | "429" | "400". Geocoding always answers with the Springfield capture.
  const mock = { forecast: "ok", requests: [] };
  const CORS = [{ name: "access-control-allow-origin", value: "*" }, { name: "content-type", value: "application/json" }];
  const answer = (requestId, file, responseCode = 200, body) =>
    send("Fetch.fulfillRequest", {
      requestId, responseCode, responseHeaders: CORS,
      body: (body ?? readFileSync(path.join(FIXTURES, file))).toString("base64"),
    });
  handlers.set("Fetch.requestPaused", ({ requestId, request }) => {
    const url = new URL(request.url);
    mock.requests.push(url.href);
    if (url.hostname.startsWith("geocoding")) return answer(requestId, "geocode-springfield.json");
    if (mock.forecast === "offline") return send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" });
    if (mock.forecast === "429") return answer(requestId, null, 429, Buffer.from('{"error":true,"reason":"Too many requests"}'));
    if (mock.forecast === "400") return answer(requestId, "error-bad-lat.json", 400);
    return answer(requestId, "forecast-new-york.json");
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://*.open-meteo.com/*" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 900, deviceScaleFactor: 1, mobile: true });

  const b = {
    logs,
    send,
    mock,
    forecastRequests: () => mock.requests.filter((u) => u.includes("api.open-meteo.com")),
    geocodeRequests: () => mock.requests.filter((u) => u.includes("geocoding-api")),
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

const fixtureUrl = `${base}?fixture=new-york`;
try {
  await b.goto(fixtureUrl);

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

  check("fixture mode: no console errors or CSP violations", b.logs.length === 0, b.logs.join(" | "));

  // ---------- live mode (Open-Meteo answered by the interceptor) ----------
  b.logs.length = 0;
  const setHorizon = (d) => b.eval(`(() => { const s = document.getElementById('horizon'); s.value = '${d}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const visible = (sel) => b.eval(`!document.querySelector(${JSON.stringify(sel)}).hidden`);
  const lastForecastParams = () => new URL(b.forecastRequests().at(-1)).searchParams;

  await b.goto(base);
  check("L0. no location yet: prompts, hides the result, makes no requests (no geolocation or search on load)",
    /Choose a location/.test(await text("#best")) && !(await visible("#result-body")) && b.mock.requests.length === 0);

  // 7. search + disambiguation
  await b.type("#q", "Sp");
  await sleepMs(500);
  check("7a. under 3 characters: no request, gentle hint", b.geocodeRequests().length === 0 && /at least 3/.test(await text("#search-status")), await text("#search-status"));
  await b.type("#q", "Spr");
  await b.send("Input.insertText", { text: "ingfield" }); // second keystroke burst inside the 300 ms debounce
  await b.waitFor("document.querySelectorAll('#results button').length > 1");
  const labels = await b.eval("[...document.querySelectorAll('#results button')].map((x) => x.textContent)");
  check("7b. debounced to a single geocoding request", b.geocodeRequests().length === 1, b.geocodeRequests().at(-1));
  check("7c. results show name, region and country, all distinguishable",
    labels.includes("Springfield, Illinois, United States") && labels.includes("Springfield, Missouri, United States") &&
      new Set(labels).size === labels.length && labels.every((l) => l.split(", ").length >= 3), labels.slice(0, 3).join(" | "));

  await b.click(`#results button[data-idx="${labels.indexOf("Springfield, Illinois, United States")}"]`);
  await b.waitFor("!document.getElementById('result-body').hidden");
  check("7d. picking a result loads its forecast under that name", (await text("#loc-name")) === "Springfield, Illinois, United States" && /^Best window/.test(await text("#best")), await text("#best"));
  const fp = lastForecastParams();
  check("7e. request uses coordinates rounded to 2 dp, 7 days, 1 past day",
    fp.get("latitude") === "39.8" && fp.get("longitude") === "-89.64" && fp.get("forecast_days") === "7" && fp.get("past_days") === "1", `${fp.get("latitude")},${fp.get("longitude")}`);
  check("7f. link hash carries the rounded location; search box and list are cleared",
    (await hashParam("lat")) === "39.8" && (await hashParam("lon")) === "-89.64" && (await b.eval("document.getElementById('q').value === '' && document.querySelectorAll('#results button').length === 0")));
  check("7g. attribution link is visible in the location card", await b.eval("(() => { const a = document.querySelector('#loc-h').closest('section').querySelector('a[href=\"https://open-meteo.com/\"]'); return !!a && a.offsetParent !== null && /Open-Meteo/.test(a.textContent); })()"));
  const liveBest = await text("#best");
  const liveHref = await b.eval("location.href");
  const reqsBeforeEdit = b.mock.requests.length;
  await b.type('.rule[data-id="wind"] input[data-field="max"]', "5");
  check("7h. live mode: editing a rule re-evaluates with no new request", b.mock.requests.length === reqsBeforeEdit && (await text("#best")) !== liveBest);
  await b.type('.rule[data-id="wind"] input[data-field="max"]', "25");

  // a shared live link opens in a fresh browser: same place, same result
  const fresh2 = await launch(9400 + Math.floor(Math.random() * 500) + 1000);
  await fresh2.goto(liveHref);
  await fresh2.waitFor("!document.getElementById('result-body').hidden");
  check("7i. shared live link reproduces location and result in a fresh browser",
    (await fresh2.eval("document.getElementById('loc-name').textContent")) === "Springfield, Illinois, United States" &&
      (await fresh2.eval("document.getElementById('best').textContent")) === liveBest);
  fresh2.close();

  check("live happy path: no console errors or CSP violations", b.logs.length === 0, b.logs.join(" | "));

  // 8. geolocation: nothing until the button is clicked, then denial falls back to search
  await b.send("Browser.setPermission", { permission: { name: "geolocation" }, setting: "denied" }).catch((e) => console.log("      (setPermission:", e.message.slice(0, 60), ")"));
  await b.click("#geo-btn");
  await b.waitFor("/denied/i.test(document.getElementById('search-status').textContent)");
  check("8a. denied geolocation: message points back to search, previous result stays", /Search for a place instead/.test(await text("#search-status")) && (await text("#loc-name")) === "Springfield, Illinois, United States");
  await b.send("Browser.grantPermissions", { permissions: ["geolocation"], origin: new URL(base).origin });
  await b.send("Emulation.setGeolocationOverride", { latitude: 39.7392, longitude: -104.9903, accuracy: 10 });
  await b.click("#geo-btn");
  await b.waitFor("document.getElementById('loc-name').textContent.startsWith('My location')").catch(async (e) => { console.log("      geo debug:", await text("#search-status"), "|", await text("#loc-name")); throw e; });
  check("8b. granted geolocation loads a forecast for rounded coordinates", (await text("#loc-name")) === "My location (39.74, -104.99)" && lastForecastParams().get("latitude") === "39.74", await text("#loc-name"));

  // manual coordinates
  await b.eval("document.querySelector('details.advanced').open = true");
  await b.type("#lat", "95");
  await b.type("#lon", "10");
  await b.click("#coords-btn");
  check("8c. out-of-range coordinates are rejected with a message", /latitude from -90 to 90/.test(await text("#search-status")));
  await b.type("#lat", "47.3769");
  await b.type("#lon", "8.5417");
  await b.click("#coords-btn");
  await b.waitFor("document.getElementById('loc-name').textContent === '47.38, 8.54'");
  check("8d. valid manual coordinates load and are rounded", lastForecastParams().get("latitude") === "47.38");

  // 9. offline: error + retry, last result stays; a failed new location keeps the previous one
  const bestBefore = await text("#best");
  b.mock.forecast = "offline";
  await setHorizon(3);
  await b.waitFor("!document.getElementById('fetch-error').hidden");
  check("9a. offline: network message and a retry button", /Couldn't reach the weather service/.test(await text("#fetch-error-text")) && (await visible("#retry-btn")), await text("#fetch-error-text"));
  check("9b. last good result stays on screen", (await visible("#result-body")) && (await text("#best")) === bestBefore && (await text("#loc-name")) === "47.38, 8.54");
  b.mock.forecast = "ok";
  await b.click("#retry-btn");
  await b.waitFor("document.getElementById('fetch-error').hidden");
  check("9c. retry succeeds and re-requests with the new horizon", lastForecastParams().get("forecast_days") === "3");

  b.mock.forecast = "offline";
  await b.type("#q", "Springfield");
  await b.waitFor("document.querySelectorAll('#results button').length > 1");
  await b.click('#results button[data-idx="0"]'); // Springfield, Missouri
  await b.waitFor("!document.getElementById('fetch-error').hidden");
  check("9d. a failed new location keeps the previous place and its forecast (never a forecast under the wrong name)", (await text("#loc-name")) === "47.38, 8.54" && (await visible("#result-body")));
  b.mock.forecast = "ok";
  await b.click("#retry-btn");
  await b.waitFor("document.getElementById('loc-name').textContent === 'Springfield, Missouri, United States'");
  check("9e. retry completes the location change and clears the error", await b.eval("document.getElementById('fetch-error').hidden"));

  // 10. rate limit, then a generic API error
  const bestNow = await text("#best");
  b.mock.forecast = "429";
  await setHorizon(14);
  await b.waitFor("!document.getElementById('fetch-error').hidden");
  check("10a. HTTP 429: friendly message, last result stays", (await text("#fetch-error-text")) === "The weather service is busy. Try again in a few minutes." && (await text("#best")) === bestNow, await text("#fetch-error-text"));
  b.mock.forecast = "400";
  await b.click("#retry-btn");
  await b.waitFor("/Something went wrong/.test(document.getElementById('fetch-error-text').textContent)");
  check("10b. API error payload: generic message, no retry button, details in the console",
    !(await visible("#retry-btn")) === true && b.logs.some((l) => /Forecast request failed/.test(l) && /Latitude must be in range/.test(l)), b.logs.at(-1)?.slice(0, 120));
  b.mock.forecast = "ok";
  await setHorizon(7);
  await b.waitFor("document.getElementById('fetch-error').hidden");
  check("10c. recovers on the next successful request", (await visible("#result-body")) && lastForecastParams().get("forecast_days") === "7");
  b.logs.length = 0;
} catch (err) {
  failed++;
  console.log("ERROR", err.stack);
}
b.close();
server.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
