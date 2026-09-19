import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRuleSet, describeRule, METRICS, RULE_TYPES } from "../docs/lib/rules.js";
import { fromDisplay, toDisplay } from "../docs/lib/units.js";

const base = () => ({
  v: 1,
  minHours: 6,
  horizonDays: 7,
  rules: [
    { id: "temp", type: "range", metric: "temp", min: 10, max: 29 },
    { id: "dew", type: "dewMargin", min: 3 },
    { id: "rh", type: "range", metric: "rh", max: 85 },
    { id: "wind", type: "range", metric: "wind", max: 25 },
    { id: "dry", type: "dry", before: 4, after: 8, maxMm: 0.1, maxProb: null },
    { id: "day", type: "daylight" },
  ],
});
const withRules = (rules) => ({ ...base(), rules });
const errorsOf = (obj) => validateRuleSet(obj).errors.join(" | ");

test("valid spec §6 example passes and is returned unchanged", () => {
  const r = validateRuleSet(base());
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.value, base());
});

test("catalogs match the spec", () => {
  assert.deepEqual(Object.keys(METRICS).sort(), ["apparent", "cloud", "gust", "precipProb", "rh", "temp", "uv", "wind"]);
  assert.deepEqual([...RULE_TYPES].sort(), ["daylight", "dewMargin", "dry", "range"]);
});

test("min > max rejected", () => {
  const r = validateRuleSet(withRules([{ id: "t", type: "range", metric: "temp", min: 30, max: 10 }]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /min.*max/i);
});

test("min == max is allowed (both inclusive)", () => {
  assert.equal(validateRuleSet(withRules([{ id: "t", type: "range", metric: "temp", min: 10, max: 10 }])).ok, true);
});

test("range needs at least one bound, and bounds must be finite numbers", () => {
  assert.equal(validateRuleSet(withRules([{ id: "t", type: "range", metric: "temp" }])).ok, false);
  for (const bad of ["10", NaN, Infinity, null]) {
    const r = validateRuleSet(withRules([{ id: "t", type: "range", metric: "temp", min: bad }]));
    // null means "absent" for min/max, so only the no-bound error applies; the rest are type errors.
    assert.equal(r.ok, false, String(bad));
  }
});

test("unknown metric and unknown type rejected, naming the rule", () => {
  assert.match(errorsOf(withRules([{ id: "x", type: "range", metric: "pressure", min: 1 }])), /x.*metric/i);
  assert.match(errorsOf(withRules([{ id: "y", type: "teleport" }])), /y.*type/i);
});

test("dry before/after clamped to 0..24 as integers", () => {
  const r = validateRuleSet(withRules([{ id: "d", type: "dry", before: 99, after: -5, maxMm: 0.1 }]));
  assert.equal(r.ok, true);
  assert.equal(r.value.rules[0].before, 24);
  assert.equal(r.value.rules[0].after, 0);
  const frac = validateRuleSet(withRules([{ id: "d", type: "dry", before: 2.6, after: 3, maxMm: 0.1 }]));
  assert.equal(frac.value.rules[0].before, 3);
});

test("dry defaults: before/after 0, maxProb null; maxMm required and >= 0; maxProb 0..100", () => {
  const r = validateRuleSet(withRules([{ id: "d", type: "dry", maxMm: 0 }]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.rules[0], { id: "d", type: "dry", before: 0, after: 0, maxMm: 0, maxProb: null });
  assert.equal(validateRuleSet(withRules([{ id: "d", type: "dry" }])).ok, false);
  assert.equal(validateRuleSet(withRules([{ id: "d", type: "dry", maxMm: -1 }])).ok, false);
  assert.equal(validateRuleSet(withRules([{ id: "d", type: "dry", maxMm: 0.1, maxProb: 101 }])).ok, false);
  assert.equal(validateRuleSet(withRules([{ id: "d", type: "dry", maxMm: 0.1, maxProb: 30 }])).ok, true);
});

test("dewMargin requires a numeric min", () => {
  assert.equal(validateRuleSet(withRules([{ id: "d", type: "dewMargin" }])).ok, false);
  assert.equal(validateRuleSet(withRules([{ id: "d", type: "dewMargin", min: 0 }])).ok, true);
});

test("more than 20 rules rejected; exactly 20 fine", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, type: "daylight" }));
  assert.equal(validateRuleSet(withRules(mk(20))).ok, true);
  const r = validateRuleSet(withRules(mk(21)));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /20/);
});

test("rule ids must be non-empty strings and unique (blockers are identified by id)", () => {
  assert.equal(validateRuleSet(withRules([{ id: "a", type: "daylight" }, { id: "a", type: "daylight" }])).ok, false);
  assert.equal(validateRuleSet(withRules([{ id: "", type: "daylight" }])).ok, false);
  assert.equal(validateRuleSet(withRules([{ type: "daylight" }])).ok, false);
});

test("enabled must be boolean when present and is preserved", () => {
  const r = validateRuleSet(withRules([{ id: "a", type: "daylight", enabled: false }]));
  assert.equal(r.ok, true);
  assert.equal(r.value.rules[0].enabled, false);
  assert.equal(validateRuleSet(withRules([{ id: "a", type: "daylight", enabled: "no" }])).ok, false);
});

test("top level: version, minHours clamp, horizon choices, rules array", () => {
  assert.equal(validateRuleSet({ ...base(), v: 2 }).ok, false);
  assert.equal(validateRuleSet({ ...base(), rules: "nope" }).ok, false);
  assert.equal(validateRuleSet(null).ok, false);
  assert.equal(validateRuleSet("x").ok, false);
  assert.equal(validateRuleSet({ ...base(), minHours: 99 }).value.minHours, 24);
  assert.equal(validateRuleSet({ ...base(), minHours: 0 }).value.minHours, 1);
  assert.equal(validateRuleSet({ ...base(), minHours: "six" }).ok, false);
  assert.equal(validateRuleSet({ ...base(), horizonDays: 5 }).ok, false);
  for (const d of [3, 7, 14]) assert.equal(validateRuleSet({ ...base(), horizonDays: d }).ok, true);
  const noHorizon = base();
  delete noHorizon.horizonDays;
  assert.equal(validateRuleSet(noHorizon).value.horizonDays, 7);
});

test("an empty rule list is valid (QA item 6: everything passes)", () => {
  assert.equal(validateRuleSet(withRules([])).ok, true);
});

test("unknown fields are dropped from the normalized value; input is not mutated", () => {
  const input = withRules([{ id: "a", type: "daylight", evil: "<script>", __proto__: { polluted: 1 } }]);
  input.extra = 1;
  const snapshot = JSON.stringify(input);
  const r = validateRuleSet(input);
  assert.equal(r.ok, true);
  assert.equal("extra" in r.value, false);
  assert.equal("evil" in r.value.rules[0], false);
  assert.equal(JSON.stringify(input), snapshot);
});

test("multiple problems are all reported", () => {
  const r = validateRuleSet(withRules([
    { id: "a", type: "range", metric: "nope", min: 1 },
    { id: "b", type: "teleport" },
  ]));
  assert.equal(r.errors.length, 2);
});

test("describeRule: metric sentences", () => {
  const s = base().rules;
  assert.equal(describeRule(s[0], "metric"), "Air temperature between 10 and 29 °C");
  assert.equal(describeRule(s[1], "metric"), "Air temperature at least 3 °C above dew point");
  assert.equal(describeRule(s[2], "metric"), "Humidity at most 85%");
  assert.equal(describeRule(s[3], "metric"), "Wind speed at most 25 km/h");
  assert.equal(describeRule(s[4], "metric"), "Dry (at most 0.1 mm/h) from 4 h before to 8 h after");
  assert.equal(describeRule(s[5], "metric"), "During daylight");
});

test("describeRule: imperial sentences (values converted, thresholds untouched)", () => {
  const s = base().rules;
  assert.equal(describeRule(s[0], "imperial"), "Air temperature between 50 and 84.2 °F");
  assert.equal(describeRule(s[1], "imperial"), "Air temperature at least 5.4 °F above dew point");
  assert.equal(describeRule(s[3], "imperial"), "Wind speed at most 15.5 mph");
  assert.equal(describeRule(s[4], "imperial"), "Dry (at most 0.004 in/h) from 4 h before to 8 h after");
  assert.equal(s[0].min, 10); // canonical value unchanged
});

test("describeRule: one-sided ranges, dry variants", () => {
  assert.equal(describeRule({ id: "a", type: "range", metric: "apparent", min: 2 }, "metric"), "Feels-like temperature at least 2 °C");
  assert.equal(describeRule({ id: "a", type: "range", metric: "uv", max: 8 }, "metric"), "UV index at most 8");
  assert.equal(
    describeRule({ id: "a", type: "dry", before: 0, after: 1, maxMm: 0.1, maxProb: 30 }, "metric"),
    "Dry (at most 0.1 mm/h and 30% rain chance) through 1 h after",
  );
  assert.equal(describeRule({ id: "a", type: "dry", before: 2, after: 0, maxMm: 0.1, maxProb: null }, "metric"), "Dry (at most 0.1 mm/h) from 2 h before");
  assert.equal(describeRule({ id: "a", type: "dry", before: 0, after: 0, maxMm: 0.5, maxProb: null }, "metric"), "Dry (at most 0.5 mm/h)");
});

test("50 °F entered in imperial stores 10 °C and displays back as 50", () => {
  const stored = fromDisplay("temp", 50, "imperial");
  assert.equal(stored, 10);
  const rule = { id: "t", type: "range", metric: "temp", min: stored, max: 29 };
  assert.equal(validateRuleSet(withRules([rule])).value.rules[0].min, 10);
  assert.equal(toDisplay("temp", stored, "imperial"), 50);
  assert.match(describeRule(rule, "imperial"), /between 50 and/);
});
