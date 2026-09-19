import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRESETS, DEFAULT_PRESET_ID, clonePreset } from "../docs/lib/presets.js";
import { validateRuleSet } from "../docs/lib/rules.js";
import { evaluateHours, findWindows, findNearMisses, pickBest } from "../docs/lib/engine.js";
import { parseForecast } from "../docs/lib/forecast.js";

const FIX = new URL("./fixtures/", import.meta.url);
const FORECASTS = ["forecast-new-york.json", "forecast-denver.json", "forecast-sydney.json", "forecast-reykjavik.json", "forecast-mid-pacific.json"];

test("the three spec §15 presets exist, in order", () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ["paint-exterior", "laundry", "bike-commute"]);
  assert.equal(DEFAULT_PRESET_ID, "paint-exterior");
});

test("every preset passes validateRuleSet unchanged", () => {
  for (const p of PRESETS) {
    const r = validateRuleSet(p.ruleSet);
    assert.equal(r.ok, true, `${p.id}: ${r.errors.join("; ")}`);
    assert.deepEqual(r.value, p.ruleSet, `${p.id} is already normalized`);
  }
});

test("every preset has a name and non-empty notes", () => {
  for (const p of PRESETS) {
    assert.ok(p.name.length > 0, p.id);
    assert.equal(typeof p.notes, "string");
    assert.ok(p.notes.trim().length > 0, p.id);
  }
});

test("paint notes carry the datasheet caveat and the source disagreement", () => {
  const paint = PRESETS.find((p) => p.id === "paint-exterior");
  assert.match(paint.notes, /datasheet/i);
  assert.match(paint.notes, /unsourced/i);
});

test("preset values match spec §15", () => {
  const byId = Object.fromEntries(PRESETS.map((p) => [p.id, p.ruleSet]));
  const rule = (id, rid) => byId[id].rules.find((r) => r.id === rid);

  assert.equal(byId["paint-exterior"].minHours, 6);
  assert.deepEqual([rule("paint-exterior", "temp").min, rule("paint-exterior", "temp").max], [10, 29]);
  assert.equal(rule("paint-exterior", "dew").min, 3);
  assert.equal(rule("paint-exterior", "rh").max, 85);
  assert.equal(rule("paint-exterior", "wind").max, 25);
  assert.equal(rule("paint-exterior", "dry").before, 4);
  assert.equal(rule("paint-exterior", "dry").after, 8);
  assert.ok(rule("paint-exterior", "day"));

  assert.equal(byId.laundry.minHours, 4);
  assert.equal(rule("laundry", "temp").min, 12);
  assert.equal(rule("laundry", "rh").max, 70);
  assert.equal(rule("laundry", "dry").after, 4);
  assert.ok(rule("laundry", "day"));

  assert.equal(byId["bike-commute"].minHours, 1);
  assert.deepEqual([rule("bike-commute", "apparent").min, rule("bike-commute", "apparent").max], [2, 32]);
  assert.equal(rule("bike-commute", "gust").max, 35);
  assert.equal(rule("bike-commute", "dry").maxProb, 30);
  assert.equal(rule("bike-commute", "dry").after, 1);
});

test("every preset evaluates on every real fixture without throwing", () => {
  for (const f of FORECASTS) {
    const { hours } = parseForecast(JSON.parse(readFileSync(new URL(f, FIX), "utf8")));
    for (const p of PRESETS) {
      const evals = evaluateHours(hours, p.ruleSet.rules);
      assert.equal(evals.length, hours.length, `${p.id} on ${f}`);
      const opts = { minHours: p.ruleSet.minHours, nowT: hours[24].t };
      const windows = findWindows(evals, opts);
      findNearMisses(evals, opts);
      pickBest(windows);
    }
  }
});

test("clonePreset returns an independent, mutable copy; unknown id -> null", () => {
  const a = clonePreset("laundry");
  a.rules[0].min = 99;
  assert.notEqual(clonePreset("laundry").rules[0].min, 99);
  assert.equal(clonePreset("nope"), null);
});

test("PRESETS is frozen so a stray edit can't leak into later sessions", () => {
  assert.throws(() => { "use strict"; PRESETS[0].ruleSet.minHours = 1; }, TypeError);
});
