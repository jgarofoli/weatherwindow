import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHours, findWindows, pickBest, findNearMisses } from "../docs/lib/engine.js";
import { makeHours } from "./support/makeHours.js";
import { deepFreeze } from "./support/deepFreeze.js";

// --- Canonical scenario S1 -------------------------------------------
// 24 hours, index 0..23, defaults: temp 20, dewPoint 12, rh 55, wind 10,
// gust 15, precip 0, precipProb 0, uv 3, cloud 30, isDay 1 for 6..19.
// Rain override: precip 1.0 at index 15.
//
// dry(before 2, after 3, maxMm 0.1): fails "wet" at h where 15 is in
// [h-2, h+3], i.e. h-2 <= 15 <= h+3 => 12 <= h <= 17.
// dry "no-data" at h where the lookback/lookahead window runs off the
// array: h=0,1 (h-2 < 0) and h=21,22,23 (h+3 > 23).
// daylight passes only for h in 6..19.
// So fully-passing hours are 6..11 (dry ok, daylight ok) and 18..19
// (dry ok since 18,19 not in the wet range; daylight ok).
function makeS1() {
  return makeHours(24, { byIndex: { 15: { precip: 1.0 } } });
}

const S1_RULES = [
  { id: "temp", type: "range", metric: "temp", min: 10, max: 29 },
  { id: "dew", type: "dewMargin", min: 3 },
  { id: "wind", type: "range", metric: "wind", max: 25 },
  { id: "dry", type: "dry", before: 2, after: 3, maxMm: 0.1 },
  { id: "day", type: "daylight" },
];

test("S1: dry fails wet for h=12..17", () => {
  const evals = evaluateHours(makeS1(), S1_RULES);
  for (let h = 12; h <= 17; h++) {
    const dryFail = evals[h].fails.find((f) => f.ruleId === "dry");
    assert.equal(dryFail.kind, "wet", `h=${h}`);
  }
});

test("S1: dry is no-data at lookback/lookahead edges", () => {
  const evals = evaluateHours(makeS1(), S1_RULES);
  for (const h of [0, 1, 21, 22, 23]) {
    const dryFail = evals[h].fails.find((f) => f.ruleId === "dry");
    assert.equal(dryFail.kind, "no-data", `h=${h}`);
  }
});

test("S1: daylight passes only 6..19", () => {
  const evals = evaluateHours(makeS1(), S1_RULES);
  for (let h = 0; h < 24; h++) {
    const dayFail = evals[h].fails.find((f) => f.ruleId === "day");
    if (h >= 6 && h <= 19) {
      assert.equal(dayFail, undefined, `h=${h}`);
    } else {
      assert.equal(dayFail.kind, "dark", `h=${h}`);
    }
  }
});

test("S1: passing hours are 6..11 and 18..19", () => {
  const evals = evaluateHours(makeS1(), S1_RULES);
  const passing = evals.filter((e) => e.pass).map((e) => e.i);
  assert.deepEqual(passing, [6, 7, 8, 9, 10, 11, 18, 19]);
});

test("S1: minHours 6 gives one window 6..11", () => {
  const evals = evaluateHours(makeS1(), S1_RULES);
  const windows = findWindows(evals, { minHours: 6 });
  assert.deepEqual(
    windows.map((w) => [w.startIdx, w.endIdx]),
    [[6, 11]],
  );
});

test("S1: minHours 2 gives two windows", () => {
  const evals = evaluateHours(makeS1(), S1_RULES);
  const windows = findWindows(evals, { minHours: 2 });
  assert.deepEqual(
    windows.map((w) => [w.startIdx, w.endIdx]),
    [
      [6, 11],
      [18, 19],
    ],
  );
});

test("S1: pickBest returns 6..11", () => {
  const evals = evaluateHours(makeS1(), S1_RULES);
  const windows = findWindows(evals, { minHours: 2 });
  const best = pickBest(windows);
  assert.equal(best.startIdx, 6);
  assert.equal(best.endIdx, 11);
});

test("S1: hours 21..23 and 0..1 have two fails each", () => {
  const evals = evaluateHours(makeS1(), S1_RULES);
  for (const h of [0, 1, 21, 22, 23]) {
    assert.equal(evals[h].fails.length, 2, `h=${h}`);
  }
});

test("S1: exactly one near-miss, 12..19, blocked by dry, failCount 6", () => {
  const evals = evaluateHours(makeS1(), S1_RULES);
  const nearMisses = findNearMisses(evals, { minHours: 6 });
  assert.equal(nearMisses.length, 1);
  assert.deepEqual(nearMisses[0], {
    startIdx: 12,
    endIdx: 19,
    hours: 8,
    blockingRuleId: "dry",
    failCount: 6,
  });
});

// --- General engine behavior -------------------------------------------

test("all hours pass -> one window covering all", () => {
  const hours = makeHours(5);
  const evals = evaluateHours(hours, []);
  const windows = findWindows(evals, { minHours: 3 });
  assert.deepEqual(windows, [
    { startIdx: 0, endIdx: 4, hours: 5, startT: hours[0].t, endT: hours[4].t },
  ]);
});

test("one failing hour splits the run; minHours filters short runs", () => {
  const hours = makeHours(10, { byIndex: { 5: { temp: 999 } } });
  const rules = [{ id: "temp", type: "range", metric: "temp", max: 30 }];
  const evals = evaluateHours(hours, rules);
  const windows = findWindows(evals, { minHours: 5 });
  assert.deepEqual(
    windows.map((w) => [w.startIdx, w.endIdx]),
    [[0, 4]],
  );
  const windows2 = findWindows(evals, { minHours: 4 });
  assert.deepEqual(
    windows2.map((w) => [w.startIdx, w.endIdx]),
    [
      [0, 4],
      [6, 9],
    ],
  );
});

test("range boundaries: min inclusive pass, just under min fails below", () => {
  const rules = [{ id: "temp", type: "range", metric: "temp", min: 10, max: 30 }];
  const atMin = evaluateHours(makeHours(1, { all: { temp: 10 } }), rules)[0];
  assert.equal(atMin.pass, true);
  const belowMin = evaluateHours(makeHours(1, { all: { temp: 9.9 } }), rules)[0];
  assert.equal(belowMin.fails[0].kind, "below");
});

test("range boundaries: max inclusive pass, just over max fails above", () => {
  const rules = [{ id: "temp", type: "range", metric: "temp", min: 10, max: 30 }];
  const atMax = evaluateHours(makeHours(1, { all: { temp: 30 } }), rules)[0];
  assert.equal(atMax.pass, true);
  const aboveMax = evaluateHours(makeHours(1, { all: { temp: 30.1 } }), rules)[0];
  assert.equal(aboveMax.fails[0].kind, "above");
});

test("epsilon: 0.3 - 0.1 dewMargin min 0.2 passes", () => {
  const rules = [{ id: "dew", type: "dewMargin", min: 0.2 }];
  const hours = makeHours(1, { all: { temp: 0.3, dewPoint: 0.1 } });
  const evals = evaluateHours(hours, rules);
  assert.equal(evals[0].pass, true);
});

test("null metric under a rule fails no-data without throwing", () => {
  const rules = [{ id: "temp", type: "range", metric: "temp", max: 30 }];
  const hours = makeHours(1, { all: { temp: null } });
  const evals = evaluateHours(hours, rules);
  assert.equal(evals[0].fails[0].kind, "no-data");
});

test("dewMargin: temp 12 / dew 10 / min 3 fails with value 2; exactly 3 passes", () => {
  const rules = [{ id: "dew", type: "dewMargin", min: 3 }];
  const failing = evaluateHours(makeHours(1, { all: { temp: 12, dewPoint: 10 } }), rules)[0];
  assert.equal(failing.fails[0].kind, "margin");
  assert.equal(failing.fails[0].value, 2);
  const passing = evaluateHours(makeHours(1, { all: { temp: 13, dewPoint: 10 } }), rules)[0];
  assert.equal(passing.pass, true);
});

test("dry: rain at index 10, before 2, after 3 -> hours 7..12 fail wet", () => {
  const hours = makeHours(24, { byIndex: { 10: { precip: 1.0 } } });
  const rules = [{ id: "dry", type: "dry", before: 2, after: 3, maxMm: 0.1 }];
  const evals = evaluateHours(hours, rules);
  for (let h = 7; h <= 12; h++) {
    assert.equal(evals[h].fails[0].kind, "wet", `h=${h}`);
  }
  assert.equal(evals[6].pass, true);
  assert.equal(evals[13].pass, true);
});

test("dry edges: no-data when lookback/lookahead runs off the array", () => {
  const hours = makeHours(24);
  const rules = [{ id: "dry", type: "dry", before: 2, after: 3, maxMm: 0.1 }];
  const evals = evaluateHours(hours, rules);
  assert.equal(evals[0].fails[0].kind, "no-data");
  assert.equal(evals[23].fails[0].kind, "no-data");
});

test("dry with maxProb: prob 41 with maxProb 40 fails wet with detail prob", () => {
  const hours = makeHours(5, { all: { precipProb: 41 } });
  const rules = [{ id: "dry", type: "dry", before: 0, after: 0, maxMm: 0.1, maxProb: 40 }];
  const evals = evaluateHours(hours, rules);
  assert.equal(evals[0].fails[0].kind, "wet");
  assert.equal(evals[0].fails[0].detail, "prob");
});

test("daylight: isDay 0 fails dark; null isDay fails no-data", () => {
  const rules = [{ id: "day", type: "daylight" }];
  const dark = evaluateHours(makeHours(1, { all: { isDay: 0 } }), rules)[0];
  assert.equal(dark.fails[0].kind, "dark");
  const noData = evaluateHours(makeHours(1, { all: { isDay: null } }), rules)[0];
  assert.equal(noData.fails[0].kind, "no-data");
});

test("multiple fails on one hour: all listed, in rule order", () => {
  const rules = [
    { id: "temp", type: "range", metric: "temp", max: 10 },
    { id: "wind", type: "range", metric: "wind", max: 5 },
  ];
  const hours = makeHours(1, { all: { temp: 20, wind: 20 } });
  const evals = evaluateHours(hours, rules);
  assert.deepEqual(
    evals[0].fails.map((f) => f.ruleId),
    ["temp", "wind"],
  );
});

test("enabled: false rule is ignored", () => {
  const rules = [{ id: "temp", type: "range", metric: "temp", max: 5, enabled: false }];
  const hours = makeHours(1, { all: { temp: 20 } });
  const evals = evaluateHours(hours, rules);
  assert.equal(evals[0].pass, true);
});

test("non-contiguous t breaks a window even if indexes are adjacent", () => {
  const hours = makeHours(5);
  for (let i = 3; i < hours.length; i++) hours[i].t += 3600; // gap between index 2 and 3
  const evals = evaluateHours(hours, []);
  const windows = findWindows(evals, { minHours: 2 });
  assert.deepEqual(
    windows.map((w) => [w.startIdx, w.endIdx]),
    [
      [0, 2],
      [3, 4],
    ],
  );
});

test("nowT: past hours are excluded from windows; the current hour is included", () => {
  const hours = makeHours(5);
  const evals = evaluateHours(hours, []);
  // hour 1 ends at hours[1].t + 3600; nowT exactly there makes it past.
  const nowT = hours[1].t + 3600;
  const windows = findWindows(evals, { minHours: 2, nowT });
  assert.deepEqual(
    windows.map((w) => [w.startIdx, w.endIdx]),
    [[2, 4]],
  );
});

test("pickBest: longest wins; tie goes to earliest; empty -> null", () => {
  assert.equal(pickBest([]), null);
  const windows = [
    { startIdx: 5, endIdx: 6, hours: 2 },
    { startIdx: 0, endIdx: 3, hours: 4 },
    { startIdx: 10, endIdx: 13, hours: 4 },
  ];
  assert.equal(pickBest(windows).startIdx, 0);
});

test("purity: inputs deep-frozen, no mutation, same output on repeat call", () => {
  const hours = deepFreeze(makeHours(10, { byIndex: { 5: { temp: 999 } } }));
  const rules = deepFreeze([{ id: "temp", type: "range", metric: "temp", max: 30 }]);
  const first = evaluateHours(hours, rules);
  const second = evaluateHours(hours, rules);
  assert.deepEqual(first, second);
});

test("unknown rule type throws TypeError", () => {
  const rules = [{ id: "bogus", type: "not-a-type" }];
  assert.throws(() => evaluateHours(makeHours(1), rules), TypeError);
});

test("near-miss: hours failing two different rules are never near-misses", () => {
  const hours = makeHours(10, {
    byIndex: { 5: { temp: 999, wind: 999 } },
  });
  const rules = [
    { id: "temp", type: "range", metric: "temp", max: 30 },
    { id: "wind", type: "range", metric: "wind", max: 30 },
  ];
  const evals = evaluateHours(hours, rules);
  const nearMisses = findNearMisses(evals, { minHours: 2 });
  assert.equal(nearMisses.length, 0);
});

test("near-miss: differing blockers close a run; short tail is dropped", () => {
  const rules = [
    { id: "wind", type: "range", metric: "wind", max: 30 },
    { id: "temp", type: "range", metric: "temp", max: 30 },
  ];
  // pass, pass, wind-fail, pass, temp-fail, pass
  const hours = makeHours(6, {
    byIndex: { 2: { wind: 999 }, 4: { temp: 999 } },
  });
  const evals = evaluateHours(hours, rules);
  const nearMisses = findNearMisses(evals, { minHours: 3 });
  assert.equal(nearMisses.length, 1);
  assert.equal(nearMisses[0].startIdx, 0);
  assert.equal(nearMisses[0].endIdx, 3);
  assert.equal(nearMisses[0].blockingRuleId, "wind");
});
