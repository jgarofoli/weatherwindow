// Post-deploy smoke test (spec §13 items 11-12) against the real site, using the real Open-Meteo APIs.
// CORS can't be tested from localhost, so this is the check that matters after every deploy.
// Usage: npm run smoke:deployed [-- https://<user>.github.io/<repo>/]   (default: derived from the git remote)
// Assertions are structural because live forecasts change. Needs network access, Node 22+ and a Chromium.
import { execSync } from "node:child_process";
import { launchChrome } from "./cdp.mjs";

function defaultUrl() {
  const remote = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error("Pass the site URL as an argument.");
  return `https://${m[1].toLowerCase()}.github.io/${m[2]}/`;
}

const url = process.argv[2] ?? defaultUrl();
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
};
console.log(`Smoke testing ${url}\n`);

const b = await launchChrome();
try {
  await b.goto(url, "document.getElementById('best')?.textContent.length>0");
  check("page loads over https with no console, CSP or CORS errors", url.startsWith("https://") && b.logs.length === 0, b.logs.join(" | "));

  await b.type("#q", "Denver");
  await b.waitFor("document.querySelectorAll('#results button').length>0", 15000).catch(() => {});
  const labels = await b.eval("[...document.querySelectorAll('#results button')].map(x=>x.textContent)");
  check("11a. geocoding call succeeds from the real origin (CORS)", labels.length > 0 && labels[0].includes("Denver"), labels.slice(0, 2).join(" | ") || (await b.eval("document.getElementById('search-status').textContent")));

  if (labels.length) {
    await b.click("#results button");
    await b.waitFor("!document.getElementById('result-body').hidden || !document.getElementById('fetch-error').hidden", 20000).catch(() => {});
  }
  const cells = await b.eval("document.querySelectorAll('.cell').length");
  const best = await b.eval("document.getElementById('best').textContent");
  check("11b. forecast call succeeds and renders (CORS)", cells > 100 && /^(Best window|No window found)/.test(best), `${cells} cells; ${best}`);
  check("11c. no CSP, CORS or console errors after search + forecast", b.logs.length === 0, b.logs.join(" | "));

  const hosts = await b.eval("[...new Set(performance.getEntriesByType('resource').map(e => new URL(e.name).host))].sort()");
  const allowed = new Set([new URL(url).host, "api.open-meteo.com", "geocoding-api.open-meteo.com"]);
  check("11d. only same-origin and Open-Meteo requests", hosts.every((h) => allowed.has(h)), hosts.join(", "));

  const attribution = await b.eval(`(() => { const a = document.querySelector('a[href="https://open-meteo.com/"]'); const loc = document.getElementById('loc-name'); return !!a && a.offsetParent !== null && /Open-Meteo/.test(a.textContent) && a.closest('section') === loc.closest('section'); })()`);
  check("12a. attribution link is visible in the location card", attribution);
  check("12b. disclaimer is visible", await b.eval("(() => { const f = document.querySelector('footer'); return !!f && f.offsetParent !== null && /Decision aid, not a guarantee/.test(f.textContent); })()"));

  const { cookies } = await b.send("Network.getAllCookies");
  check("12c. no cookies are set (document.cookie and the browser's cookie jar)", cookies.length === 0 && (await b.eval("document.cookie")) === "", cookies.map((c) => c.name).join(","));

  const link = await b.eval("location.href");
  const fresh = await launchChrome();
  try {
    await fresh.goto(link, "!document.getElementById('result-body').hidden || !document.getElementById('fetch-error').hidden", 20000);
    check("shared link reopens the same location in a fresh browser",
      (await fresh.eval("document.getElementById('loc-name').textContent")) === (await b.eval("document.getElementById('loc-name').textContent")) &&
        (await fresh.eval("document.querySelectorAll('.cell').length")) > 100 && fresh.logs.length === 0, fresh.logs.join(" | "));
  } finally {
    fresh.close();
  }
} catch (err) {
  failed++;
  console.log("ERROR", err.message);
}
b.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
