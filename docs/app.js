// DOM glue only: state, events, rendering. All logic lives in ./lib/ (pure, tested).
// Every string that reaches the DOM goes through textContent / setAttribute, never innerHTML.
import { evaluateHours, findWindows, findNearMisses } from "./lib/engine.js";
import { parseForecast } from "./lib/forecast.js";
import { buildViewModel } from "./lib/viewmodel.js";
import { PRESETS, DEFAULT_PRESET_ID, clonePreset } from "./lib/presets.js";
import { validateRuleSet, METRICS, ruleName, MAX_RULES, HORIZONS } from "./lib/rules.js";
import { encodeState, decodeState } from "./lib/urlstate.js";
import { displayNumber, fromDisplay, unitLabel } from "./lib/units.js";

const $ = (id) => document.getElementById(id);
const GLYPH = { pass: "✓", near: "~", fail: "✕", past: "·" };
const STORAGE_KEY = "wwf:v1:saved";
const MAX_SAVED = 20;
const LOCALE = navigator.language || "en-US";

const state = {
  loc: null,
  units: "metric",
  ruleSet: clonePreset(DEFAULT_PRESET_ID),
  forecast: null, // parseForecast output
  nowT: 0,
  vm: null,
  selected: null, // hour index
  dayOpen: null, // dateKey
  fixture: null,
};

// ---------- small DOM helpers ----------
function el(tag, { text, cls, attrs } = {}, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}
const span = (text) => el("span", { text });
const clear = (node) => node.replaceChildren();

function canon(o) {
  if (Array.isArray(o)) return `[${o.map(canon).join(",")}]`;
  if (o && typeof o === "object") {
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(o);
}

// ---------- saved rule sets (localStorage is a cache, never trusted) ----------
function loadSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw.slice(0, MAX_SAVED)) {
      const checked = item && typeof item.name === "string" ? validateRuleSet(item.ruleSet) : null;
      if (checked?.ok) out.push({ name: item.name.slice(0, 40), ruleSet: checked.value });
    }
    return out;
  } catch {
    return [];
  }
}
function writeSaved(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

// ---------- compute + URL ----------
function compute() {
  const { hours, tz } = state.forecast;
  const rs = state.ruleSet;
  const visible = hours.slice(0, Math.min(hours.length, 24 + 24 * rs.horizonDays)); // 1 past day + horizon
  const evals = evaluateHours(visible, rs.rules);
  const opts = { minHours: rs.minHours, nowT: state.nowT };
  const windows = findWindows(evals, opts);
  const nearMisses = findNearMisses(evals, opts);
  state.vm = buildViewModel({
    hours: visible, evals, windows, nearMisses, tz, locale: LOCALE, nowT: state.nowT, units: state.units, rules: rs.rules,
  });
}

function syncUrl() {
  try {
    history.replaceState(null, "", location.pathname + location.search + encodeState(state));
  } catch {
    /* sandboxed or file context: sharing just won't reflect edits */
  }
}

function showBanner(text) {
  const b = $("banner");
  b.textContent = text;
  b.hidden = !text;
}

// ---------- result rendering ----------
function cellDescription(cell) {
  if (cell.state === "past") return "past hour";
  if (cell.state === "pass") return "passes all rules";
  return cell.fails.map((f) => f.text).join("; ");
}

function renderGrid() {
  const grid = $("grid");
  clear(grid);
  const windowIdx = new Map(); // hour index -> "best" | "other"
  for (const w of state.vm.windows) {
    for (let i = w.startIdx; i <= w.endIdx; i++) windowIdx.set(i, w.isBest ? "best" : "other");
  }

  const days = state.vm.days.filter((d) => d.cells.some((c) => c.state !== "past"));

  const ruler = el("div", { cls: "grow" }, el("span"), el("div", { cls: "cells ruler" }));
  ruler.lastChild.style.gridTemplateColumns = "repeat(24, minmax(0, 1fr))";
  for (const h of [0, 6, 12, 18]) {
    const s = span(String(h).padStart(2, "0"));
    s.style.gridColumn = String(h + 1);
    ruler.lastChild.append(s);
  }
  ruler.setAttribute("aria-hidden", "true");
  grid.append(ruler);

  let firstFocusable = true;
  for (const day of days) {
    const row = el("div", { cls: "grow" });
    const label = el("button", {
      cls: "daylabel", text: day.label,
      attrs: { type: "button", "aria-expanded": String(state.dayOpen === day.dateKey), "aria-label": `Show every hour of ${day.label}` },
    });
    label.dataset.day = day.dateKey;
    const cells = el("div", { cls: "cells" });
    const shift = day.cells.some((c) => c.ambiguous) ? 1 : 0; // fall-back day has 25 cells
    cells.style.gridTemplateColumns = `repeat(${24 + shift}, minmax(0, 1fr))`;
    let after = 0;
    for (const c of day.cells) {
      if (c.ambiguous) after = 1;
      const b = el("button", {
        cls: `cell state-${c.state}` + (windowIdx.has(c.i) ? (windowIdx.get(c.i) === "best" ? " win best" : " win") : ""),
        text: GLYPH[c.state],
        attrs: {
          type: "button",
          "aria-label": `${day.label} ${c.label}: ${cellDescription(c)}`,
          "aria-pressed": String(state.selected === c.i),
          tabindex: "-1",
        },
      });
      b.dataset.i = String(c.i);
      b.style.gridColumn = String(c.hour + 1 + after);
      if (firstFocusable && state.selected === null) { b.tabIndex = 0; firstFocusable = false; }
      if (state.selected === c.i) b.tabIndex = 0;
      cells.append(b);
    }
    row.append(label, cells);
    grid.append(row);
  }
  if (state.selected === null || !grid.querySelector('.cell[tabindex="0"]')) {
    const first = grid.querySelector(".cell");
    if (first) first.tabIndex = 0;
  }
}

function findCell(i) {
  for (const d of state.vm.days) for (const c of d.cells) if (c.i === i) return { day: d, cell: c };
  return null;
}

function renderDetail() {
  const box = $("detail");
  clear(box);
  if (state.dayOpen !== null) {
    const day = state.vm.days.find((d) => d.dateKey === state.dayOpen);
    if (day) {
      box.append(el("h3", { text: day.label }));
      const ul = el("ul", { cls: "hourlist" });
      for (const c of day.cells) {
        ul.append(el("li", {},
          el("span", { cls: `key state-${c.state}`, text: GLYPH[c.state], attrs: { "aria-hidden": "true" } }),
          span(`${c.label}: ${cellDescription(c)}`)));
      }
      box.append(ul);
      box.hidden = false;
      return;
    }
  }
  const hit = state.selected === null ? null : findCell(state.selected);
  if (!hit) {
    box.hidden = true;
    return;
  }
  const { day, cell } = hit;
  box.append(el("h3", { text: `${day.label}, ${cell.label}` }));
  if (cell.state === "pass") box.append(el("p", { text: "Passes all rules." }));
  else {
    if (cell.state === "past") box.append(el("p", { text: "Past hour. Not counted in any window." }));
    if (cell.fails.length === 0) box.append(el("p", { text: "Passes all rules." }));
    else {
      box.append(el("p", { text: cell.fails.length === 1 ? "Fails 1 rule:" : `Fails ${cell.fails.length} rules:` }));
      const ul = el("ul");
      for (const f of cell.fails) ul.append(el("li", { text: f.text }));
      box.append(ul);
    }
  }
  box.hidden = false;
}

function renderLists() {
  const wl = $("windows");
  clear(wl);
  for (const w of state.vm.windows) wl.append(el("li", { text: w.sentence, cls: w.isBest ? "best-window" : "" }));
  const ml = $("misses");
  clear(ml);
  // Runs where every hour fails one rule are the least actionable; show partial misses first.
  const partialFirst = [...state.vm.nearMisses].sort((a, b) => (a.failCount === a.hours) - (b.failCount === b.hours));
  for (const m of partialFirst.slice(0, 3)) ml.append(el("li", { text: m.sentence }));
}

function renderResult() {
  compute();
  $("best").textContent = state.vm.bestSentence;
  renderGrid();
  renderDetail();
  renderLists();
}

function selectCell(i, { focus = false } = {}) {
  state.selected = i;
  state.dayOpen = null;
  for (const b of $("grid").querySelectorAll(".cell")) {
    const on = Number(b.dataset.i) === i;
    b.setAttribute("aria-pressed", String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  for (const d of $("grid").querySelectorAll(".daylabel")) d.setAttribute("aria-expanded", "false");
  renderDetail();
}

function toggleDay(dateKey) {
  state.dayOpen = state.dayOpen === dateKey ? null : dateKey;
  for (const d of $("grid").querySelectorAll(".daylabel")) {
    d.setAttribute("aria-expanded", String(state.dayOpen === d.dataset.day));
  }
  renderDetail();
}

// Arrow keys: left/right = adjacent hour, up/down = same hour on the adjacent day.
function onGridKey(e) {
  const cur = e.target.closest(".cell");
  if (!cur || !e.key.startsWith("Arrow")) return;
  const rows = [...$("grid").querySelectorAll(".grow")].filter((r) => r.querySelector(".cell"));
  const rowOf = cur.closest(".grow");
  const r = rows.indexOf(rowOf);
  let target = null;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const all = [...$("grid").querySelectorAll(".cell")];
    target = all[all.indexOf(cur) + (e.key === "ArrowRight" ? 1 : -1)];
  } else {
    const other = rows[r + (e.key === "ArrowDown" ? 1 : -1)];
    if (other) {
      const col = Number(cur.style.gridColumn);
      const cands = [...other.querySelectorAll(".cell")];
      target = cands.reduce((best, c) => (Math.abs(Number(c.style.gridColumn) - col) < Math.abs(Number(best.style.gridColumn) - col) ? c : best), cands[0]);
    }
  }
  if (target) {
    e.preventDefault();
    selectCell(Number(target.dataset.i), { focus: true });
  }
}

// ---------- rules editing ----------
const TEMPLATES = [
  { key: "temp", label: "Air temperature", make: () => ({ type: "range", metric: "temp", min: 10, max: 29 }) },
  { key: "apparent", label: "Feels-like temperature", make: () => ({ type: "range", metric: "apparent", min: 2, max: 32 }) },
  { key: "dew", label: "Dew-point margin", make: () => ({ type: "dewMargin", min: 3 }) },
  { key: "rh", label: "Humidity", make: () => ({ type: "range", metric: "rh", max: 85 }) },
  { key: "wind", label: "Wind speed", make: () => ({ type: "range", metric: "wind", max: 25 }) },
  { key: "gust", label: "Wind gusts", make: () => ({ type: "range", metric: "gust", max: 35 }) },
  { key: "precipProb", label: "Rain chance", make: () => ({ type: "range", metric: "precipProb", max: 30 }) },
  { key: "uv", label: "UV index", make: () => ({ type: "range", metric: "uv", max: 8 }) },
  { key: "cloud", label: "Cloud cover", make: () => ({ type: "range", metric: "cloud", max: 60 }) },
  { key: "dry", label: "Dry spell", make: () => ({ type: "dry", before: 0, after: 0, maxMm: 0.1, maxProb: null }) },
  { key: "day", label: "Daylight only", make: () => ({ type: "daylight" }) },
];

const display = (kind, v) => (kind === "int" ? String(v) : displayNumber(kind, v, state.units));
const toCanon = (kind, n) => (kind === "int" ? n : fromDisplay(kind, n, state.units));

function numField(rule, name, kind, label, extra = {}) {
  const input = el("input", { cls: "num", attrs: { type: "number", step: "any", inputmode: "decimal", "aria-label": label, ...extra } });
  input.dataset.field = name;
  input.dataset.kind = kind;
  const v = rule[name];
  input.dataset.canon = v === undefined || v === null ? "" : String(v);
  input.value = v === undefined || v === null ? "" : display(kind, v);
  return input;
}

function ruleRow(rule) {
  const li = el("li", { cls: "rule" + (rule.enabled === false ? " disabled" : "") });
  li.dataset.id = rule.id;
  const name = ruleName(rule);
  const cb = el("input", { attrs: { type: "checkbox", "aria-label": `Enabled: ${name}` } });
  cb.className = "enabled";
  cb.checked = rule.enabled !== false;
  const s = el("div", { cls: "sentence" });
  switch (rule.type) {
    case "range": {
      const kind = METRICS[rule.metric].kind;
      const u = unitLabel(kind, state.units);
      s.append(span(name), span("at least"), numField(rule, "min", kind, `${name} minimum`, { placeholder: "none" }),
        span("at most"), numField(rule, "max", kind, `${name} maximum`, { placeholder: "none" }));
      if (u) s.append(span(u));
      break;
    }
    case "dewMargin":
      s.append(span("Air temperature at least"), numField(rule, "min", "tempDelta", "Dew-point margin minimum"),
        span(`${unitLabel("tempDelta", state.units)} above dew point`));
      break;
    case "dry":
      s.append(span("Dry: rain at most"), numField(rule, "maxMm", "precip", "Maximum rain per hour", { min: "0" }),
        span(`${unitLabel("precip", state.units)}/h, chance at most`),
        numField(rule, "maxProb", "pct", "Maximum rain chance, optional", { min: "0", max: "100", placeholder: "any" }),
        span("% from"), numField(rule, "before", "int", "Hours dry before", { min: "0", max: "24", step: "1" }),
        span("h before to"), numField(rule, "after", "int", "Hours dry after", { min: "0", max: "24", step: "1" }),
        span("h after"));
      break;
    default:
      s.append(span("During daylight"));
  }
  const rm = el("button", { cls: "remove", text: "✕", attrs: { type: "button", "aria-label": `Remove rule: ${name}` } });
  li.append(cb, s, rm);
  return li;
}

function renderRules() {
  const list = $("rule-list");
  clear(list);
  for (const r of state.ruleSet.rules) list.append(ruleRow(r));
  $("no-rules").hidden = state.ruleSet.rules.length > 0;
  $("add-rule-btn").disabled = state.ruleSet.rules.length >= MAX_RULES;
}

function renderControls() {
  const preset = $("preset");
  const cur = canon(state.ruleSet);
  const saved = loadSaved();
  clear(preset);
  for (const p of PRESETS) preset.append(el("option", { text: p.name, attrs: { value: `preset:${p.id}` } }));
  if (saved.length) {
    const g = el("optgroup", { attrs: { label: "Saved" } });
    saved.forEach((s, i) => g.append(el("option", { text: s.name, attrs: { value: `saved:${i}` } })));
    preset.append(g);
  }
  preset.append(el("option", { text: "Custom", attrs: { value: "custom", disabled: "" } }));
  let selected = "custom";
  let notes = "Custom rules. Thresholds are editable; your product's datasheet overrides any preset.";
  let savedIdx = -1;
  const p = PRESETS.find((x) => canon(x.ruleSet) === cur);
  if (p) {
    selected = `preset:${p.id}`;
    notes = p.notes;
  } else {
    savedIdx = saved.findIndex((s) => canon(s.ruleSet) === cur);
    if (savedIdx >= 0) {
      selected = `saved:${savedIdx}`;
      notes = "Your saved rules.";
    }
  }
  preset.value = selected;
  $("preset-notes").textContent = notes;
  $("delete-saved").hidden = savedIdx < 0;
  $("delete-saved").dataset.idx = String(savedIdx);

  $("min-hours").value = String(state.ruleSet.minHours);
  const horizon = $("horizon");
  if (!horizon.options.length) {
    for (const d of HORIZONS) horizon.append(el("option", { text: `${d} days`, attrs: { value: String(d) } }));
  }
  horizon.value = String(state.ruleSet.horizonDays);
  for (const r of document.querySelectorAll('input[name="units"]')) r.checked = r.value === state.units;
}

function showErrors(errors) {
  const box = $("rule-errors");
  box.textContent = errors.join(" ");
  box.hidden = errors.length === 0;
}

// Validates a candidate rule set; on success it becomes state and everything re-evaluates locally.
function commit(candidate, { rebuild = false } = {}) {
  const r = validateRuleSet(candidate);
  if (!r.ok) {
    showErrors(r.errors);
    return false;
  }
  showErrors([]);
  state.ruleSet = r.value;
  renderResult();
  renderControls();
  if (rebuild) renderRules();
  syncUrl();
  return true;
}

// Rebuild one rule from its row's inputs. Each input remembers its canonical (unrounded) value in
// data-canon; only the field the user touched is overwritten, so display rounding never leaks into storage.
function commitRow(li) {
  const base = state.ruleSet.rules.find((r) => r.id === li.dataset.id);
  if (!base) return;
  const rule = structuredClone(base);
  rule.enabled = li.querySelector(".enabled").checked ? undefined : false;
  if (rule.enabled === undefined) delete rule.enabled;
  for (const input of li.querySelectorAll("input.num")) {
    const c = input.dataset.canon;
    if (c === "") delete rule[input.dataset.field];
    else rule[input.dataset.field] = Number(c);
  }
  li.classList.toggle("disabled", rule.enabled === false);
  const candidate = structuredClone(state.ruleSet);
  candidate.rules = candidate.rules.map((r) => (r.id === rule.id ? rule : r));
  commit(candidate);
}

function onRuleInput(e) {
  const input = e.target;
  if (!input.matches("input.num")) return;
  const v = input.value.trim();
  const kind = input.dataset.kind;
  if (v === "") input.dataset.canon = "";
  else {
    const n = Number(v);
    if (!Number.isFinite(n)) return showErrors(["Enter a number."]);
    input.dataset.canon = String(toCanon(kind, n));
  }
  commitRow(input.closest(".rule"));
}

// On blur, show what was actually stored (e.g. hours clamped to 24).
function onRuleChange(e) {
  const input = e.target;
  if (!input.matches("input.num")) return;
  const rule = state.ruleSet.rules.find((r) => r.id === input.closest(".rule").dataset.id);
  const v = rule?.[input.dataset.field];
  if (v === undefined || v === null) return;
  input.dataset.canon = String(v);
  input.value = display(input.dataset.kind, v);
}

function onRuleClick(e) {
  if (e.target.matches("input.enabled")) return commitRow(e.target.closest(".rule"));
  const rm = e.target.closest("button.remove");
  if (!rm) return;
  const id = rm.closest(".rule").dataset.id;
  const candidate = structuredClone(state.ruleSet);
  candidate.rules = candidate.rules.filter((r) => r.id !== id);
  commit(candidate, { rebuild: true });
}

function addRule() {
  const tpl = TEMPLATES.find((t) => t.key === $("add-rule").value);
  if (!tpl) return;
  const ids = new Set(state.ruleSet.rules.map((r) => r.id));
  let id = tpl.key;
  for (let n = 2; ids.has(id); n++) id = `${tpl.key}${n}`;
  const candidate = structuredClone(state.ruleSet);
  candidate.rules.push({ id, ...tpl.make() });
  commit(candidate, { rebuild: true });
}

function setStatus(text) {
  $("action-status").textContent = text;
}

function onPreset() {
  const [kind, key] = $("preset").value.split(":");
  let rs = null;
  if (kind === "preset") rs = clonePreset(key);
  else if (kind === "saved") rs = loadSaved()[Number(key)]?.ruleSet ?? null;
  if (rs) commit(rs, { rebuild: true });
}

function saveRules() {
  const cur = canon(state.ruleSet);
  const preset = PRESETS.find((x) => canon(x.ruleSet) === cur);
  const name = ($("save-name").value.trim() || (preset ? preset.name : "My rules")).slice(0, 40);
  const list = loadSaved();
  const at = list.findIndex((s) => s.name === name);
  if (at >= 0) list[at] = { name, ruleSet: state.ruleSet };
  else if (list.length >= MAX_SAVED) return setStatus(`You can keep up to ${MAX_SAVED} saved sets. Delete one first.`);
  else list.push({ name, ruleSet: state.ruleSet });
  if (!writeSaved(list)) return setStatus("Couldn't save: browser storage is unavailable.");
  $("save-name").value = "";
  renderControls();
  setStatus(`Saved "${name}".`);
}

function deleteSaved() {
  const idx = Number($("delete-saved").dataset.idx);
  const list = loadSaved();
  if (!(idx >= 0 && idx < list.length)) return;
  const [gone] = list.splice(idx, 1);
  writeSaved(list);
  renderControls();
  setStatus(`Deleted "${gone.name}".`);
}

async function copyLink() {
  syncUrl();
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus("Link copied.");
  } catch {
    setStatus("Couldn't copy automatically. Copy the address from your browser's address bar.");
  }
}

// ---------- boot ----------
async function loadFixture(name, manifest) {
  const res = await fetch(`./dev/${encodeURIComponent(name)}.json`);
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
  const json = await res.json();
  const label = manifest.fixtures.find((f) => f.name === name)?.label ?? name;
  return { forecast: parseForecast(json), loc: { name: `${label} (sample data)`, lat: json.latitude, lon: json.longitude } };
}

async function boot() {
  const decoded = decodeState(location.hash);
  state.units = decoded.state.units;
  state.ruleSet = decoded.state.ruleSet;
  if (decoded.warnings.length) {
    console.warn("Shared link problems:", decoded.warnings);
    showBanner("Couldn't read the shared link. Showing the default rules.");
  }

  for (const t of TEMPLATES) $("add-rule").append(el("option", { text: t.label, attrs: { value: t.key } }));

  // Live data (search, geolocation, Open-Meteo fetch) arrives in M6; until then the page runs on captured samples.
  const params = new URLSearchParams(location.search);
  try {
    const manifest = await (await fetch("./dev/manifest.json")).json();
    const sel = $("fixture-select");
    for (const f of manifest.fixtures) sel.append(el("option", { text: f.label, attrs: { value: f.name } }));
    let name = params.get("fixture") ?? "new-york";
    if (!manifest.fixtures.some((f) => f.name === name)) {
      showBanner(`Unknown sample "${name.slice(0, 40)}". Showing New York.`);
      name = "new-york";
    }
    sel.value = name;
    $("dev-fixture").hidden = false;
    const now = Number(params.get("now"));
    state.nowT = Number.isInteger(now) && now > 0 ? now : Math.floor(Date.parse(manifest.capturedAt) / 1000);
    const { forecast, loc } = await loadFixture(name, manifest);
    state.forecast = forecast;
    state.loc = loc;
    state.fixture = name;
    if (!decoded.warnings.length) showBanner("Showing saved sample data. Live search arrives in the next milestone.");
  } catch (err) {
    console.error(err);
    showBanner("Couldn't load the forecast data.");
    return;
  }

  $("loc-name").textContent = state.loc.name;
  renderControls();
  renderRules();
  renderResult();
  syncUrl();
}

$("grid").addEventListener("click", (e) => {
  const cell = e.target.closest(".cell");
  if (cell) return selectCell(Number(cell.dataset.i));
  const day = e.target.closest(".daylabel");
  if (day) toggleDay(day.dataset.day);
});
$("grid").addEventListener("keydown", onGridKey);
$("rule-list").addEventListener("input", onRuleInput);
$("rule-list").addEventListener("change", onRuleChange);
$("rule-list").addEventListener("click", onRuleClick);
$("add-rule-btn").addEventListener("click", addRule);
$("preset").addEventListener("change", onPreset);
$("min-hours").addEventListener("input", (e) => {
  if (e.target.value.trim() === "") return;
  const c = structuredClone(state.ruleSet);
  c.minHours = Number(e.target.value);
  commit(c);
});
$("min-hours").addEventListener("change", () => ($("min-hours").value = String(state.ruleSet.minHours)));
$("horizon").addEventListener("change", (e) => {
  const c = structuredClone(state.ruleSet);
  c.horizonDays = Number(e.target.value);
  commit(c);
});
for (const r of document.querySelectorAll('input[name="units"]')) {
  r.addEventListener("change", () => {
    state.units = r.value;
    renderRules();
    renderResult();
    renderControls();
    syncUrl();
  });
}
$("save-btn").addEventListener("click", saveRules);
$("delete-saved").addEventListener("click", deleteSaved);
$("copy-link").addEventListener("click", copyLink);
$("fixture-select").addEventListener("change", (e) => {
  location.href = `${location.pathname}?fixture=${encodeURIComponent(e.target.value)}${location.hash}`;
});

boot();
