import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeState, decodeState } from "../docs/lib/urlstate.js";
import { clonePreset } from "../docs/lib/presets.js";
import { validateRuleSet } from "../docs/lib/rules.js";

const paint = () => clonePreset("paint-exterior");
const sample = () => ({ loc: { name: "Denver, Colorado, United States", lat: 39.74, lon: -104.99 }, units: "imperial", ruleSet: paint() });
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const param = (hash, k) => new URLSearchParams(hash.replace(/^#/, "")).get(k);

test("round trip preserves location, units and rules", () => {
  const { state, warnings } = decodeState(encodeState(sample()));
  assert.deepEqual(warnings, []);
  assert.deepEqual(state, sample());
});

test("hash form: #v=1&lat&lon&n&u&r with r = base64url(JSON)", () => {
  const h = encodeState(sample());
  assert.ok(h.startsWith("#v=1&"));
  assert.equal(param(h, "lat"), "39.74");
  assert.equal(param(h, "lon"), "-104.99");
  assert.equal(param(h, "n"), "Denver, Colorado, United States");
  assert.equal(param(h, "u"), "imperial");
  assert.deepEqual(JSON.parse(Buffer.from(param(h, "r"), "base64url").toString("utf8")), paint());
  assert.doesNotMatch(param(h, "r"), /[+/=]/);
});

test("coordinates are rounded to 2 decimals in the hash", () => {
  const s = sample();
  s.loc.lat = 39.7392358;
  s.loc.lon = -104.9902512;
  const h = encodeState(s);
  assert.equal(param(h, "lat"), "39.74");
  assert.equal(param(h, "lon"), "-104.99");
  assert.equal(decodeState(h).state.loc.lat, 39.74);
});

test("decode also rounds hand-edited coordinates", () => {
  const h = `#v=1&lat=39.123456&lon=-104.987654&n=x&u=metric&r=${b64url(JSON.stringify(paint()))}`;
  const { state } = decodeState(h);
  assert.equal(state.loc.lat, 39.12);
  assert.equal(state.loc.lon, -104.99);
});

test("no location: hash omits lat/lon/n and decodes to loc null", () => {
  const s = { ...sample(), loc: null };
  const h = encodeState(s);
  assert.equal(param(h, "lat"), null);
  const { state, warnings } = decodeState(h);
  assert.equal(state.loc, null);
  assert.deepEqual(warnings, []);
});

test("accepts input with or without leading #", () => {
  const h = encodeState(sample());
  assert.deepEqual(decodeState(h.slice(1)).state, sample());
});

test("empty hash -> defaults, no warning (a fresh visit)", () => {
  for (const h of ["", "#", undefined, null]) {
    const { state, warnings } = decodeState(h);
    assert.deepEqual(warnings, [], String(h));
    assert.equal(state.loc, null);
    assert.equal(state.units, "metric");
    assert.deepEqual(state.ruleSet, paint());
  }
});

test("unknown version -> defaults + warning", () => {
  const h = encodeState(sample()).replace("v=1", "v=9");
  const { state, warnings } = decodeState(h);
  assert.equal(state.loc, null);
  assert.deepEqual(state.ruleSet, paint());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /version/i);
});

test("missing version on a non-empty hash -> defaults + warning", () => {
  const { state, warnings } = decodeState("#lat=1&lon=2");
  assert.equal(state.loc, null);
  assert.equal(warnings.length, 1);
});

test("tampered base64 -> default rules + warning, no throw", () => {
  const h = encodeState(sample());
  const r = param(h, "r");
  for (const bad of [r.slice(0, 20) + "!!!" + r.slice(23), r.slice(0, 15), "%%%", "e30", b64url("[1,2"), b64url("null")]) {
    const tampered = h.replace(/r=[^&]*/, `r=${encodeURIComponent(bad)}`);
    let out;
    assert.doesNotThrow(() => { out = decodeState(tampered); }, bad);
    assert.deepEqual(out.state.ruleSet, paint(), bad);
    assert.ok(out.warnings.length >= 1, bad);
    // location and units were untouched, so they survive
    assert.equal(out.state.loc.lat, 39.74);
    assert.equal(out.state.units, "imperial");
  }
});

test("decoded rules that fail validation fall back to defaults + warning", () => {
  const bad = { ...paint(), rules: [{ id: "t", type: "range", metric: "temp", min: 30, max: 10 }] };
  const h = `#v=1&u=metric&r=${b64url(JSON.stringify(bad))}`;
  const { state, warnings } = decodeState(h);
  assert.deepEqual(state.ruleSet, paint());
  assert.equal(warnings.length, 1);
});

test("decoded ruleSet is the validated (normalized, clamped) value", () => {
  const raw = { ...paint(), rules: [{ id: "d", type: "dry", before: 99, after: 1, maxMm: 0.1, evil: 1 }] };
  const h = `#v=1&u=metric&r=${b64url(JSON.stringify(raw))}`;
  const { state } = decodeState(h);
  assert.equal(state.ruleSet.rules[0].before, 24);
  assert.equal("evil" in state.ruleSet.rules[0], false);
  assert.equal(validateRuleSet(state.ruleSet).ok, true);
});

test("bad coordinates -> loc null + warning; other state survives", () => {
  for (const q of ["lat=abc&lon=2", "lat=91&lon=2", "lat=1&lon=181", "lat=1", "lat=NaN&lon=1", "lat=&lon="]) {
    const { state, warnings } = decodeState(`#v=1&${q}&u=imperial`);
    assert.equal(state.loc, null, q);
    assert.equal(state.units, "imperial", q);
    assert.ok(warnings.length >= 1, q);
  }
});

test("bad units -> metric + warning", () => {
  const { state, warnings } = decodeState("#v=1&u=furlongs");
  assert.equal(state.units, "metric");
  assert.equal(warnings.length, 1);
});

test("hostile name stays inert data: control chars stripped, capped at 80", () => {
  const s = sample();
  s.loc.name = "<script>alert(1)</script>\u0000\u0007\u001b[31m\u009f\n\t" + "x".repeat(200);
  const h = encodeState(s);
  const { state } = decodeState(h);
  assert.doesNotMatch(state.loc.name, CONTROL);
  assert.ok(state.loc.name.length <= 80);
  assert.ok(state.loc.name.startsWith("<script>alert(1)</script>"), "not escaped or rewritten, rendering safety is textContent's job");
});

test("hand-written hostile name is sanitized on decode too", () => {
  const h = `#v=1&lat=1&lon=2&n=${encodeURIComponent("a\u0000b\u0085c" + "y".repeat(500))}&u=metric`;
  const { state } = decodeState(h);
  assert.doesNotMatch(state.loc.name, CONTROL);
  assert.ok(state.loc.name.length <= 80);
  assert.ok(state.loc.name.startsWith("abc"));
});

test("name is capped by characters, not UTF-16 halves (no lone surrogates)", () => {
  const s = sample();
  s.loc.name = "🌧".repeat(100);
  const { state } = decodeState(encodeState(s));
  assert.equal(Array.from(state.loc.name).length, 80);
  assert.doesNotThrow(() => encodeURIComponent(state.loc.name));
});

test("non-ASCII names and rule text round trip", () => {
  const s = sample();
  s.loc.name = "Reykjavík, Ísland";
  assert.equal(decodeState(encodeState(s)).state.loc.name, "Reykjavík, Ísland");
});

test("missing name with valid coords falls back to a coordinate label", () => {
  const { state } = decodeState("#v=1&lat=39.74&lon=-104.99");
  assert.equal(state.loc.name, "39.74, -104.99");
});

test("hash stays under 2000 chars for a 10-rule set with a long name", () => {
  const s = sample();
  s.loc.name = "n".repeat(80);
  s.ruleSet.rules = [
    { id: "temp", type: "range", metric: "temp", min: 10, max: 29 },
    { id: "app", type: "range", metric: "apparent", min: 2, max: 32 },
    { id: "dew", type: "dewMargin", min: 3 },
    { id: "rh", type: "range", metric: "rh", max: 85 },
    { id: "wind", type: "range", metric: "wind", max: 25 },
    { id: "gust", type: "range", metric: "gust", max: 35 },
    { id: "uv", type: "range", metric: "uv", max: 8 },
    { id: "cloud", type: "range", metric: "cloud", max: 60 },
    { id: "dry", type: "dry", before: 4, after: 8, maxMm: 0.1, maxProb: 30 },
    { id: "day", type: "daylight" },
  ];
  const h = encodeState(s);
  assert.ok(h.length < 2000, `length ${h.length}`);
  assert.deepEqual(decodeState(h).state.ruleSet, s.ruleSet);
});

test("absurdly long hashes are refused without parsing", () => {
  const { state, warnings } = decodeState("#v=1&r=" + "A".repeat(50000));
  assert.deepEqual(state.ruleSet, paint());
  assert.ok(warnings.length >= 1);
});

test("decodeState never throws on garbage", () => {
  for (const g of ["#%E0%A4%A", "#=&&==", "#v=1&r=", "#v=1&lat=1e999&lon=1", "#__proto__=1", 42, {}, "#v=1&n=%"]) {
    assert.doesNotThrow(() => decodeState(g), String(g));
  }
});

test("encodeState: units default to metric; invalid ruleSet is not silently emitted", () => {
  const s = sample();
  delete s.units;
  assert.equal(param(encodeState(s), "u"), "metric");
  s.ruleSet.rules = [{ id: "t", type: "range", metric: "temp", min: 30, max: 10 }];
  const h = encodeState(s);
  assert.equal(param(h, "r"), null);
  assert.deepEqual(decodeState(h).state.ruleSet, paint()); // falls back to defaults
});
