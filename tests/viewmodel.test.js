import { test } from "node:test";
import assert from "node:assert/strict";
import { buildViewModel } from "../docs/lib/viewmodel.js";
import { evaluateHours, findWindows, findNearMisses } from "../docs/lib/engine.js";
import { groupByLocalDay } from "../docs/lib/timefmt.js";
import { makeHours, START_T } from "./support/makeHours.js";
import { deepFreeze } from "./support/deepFreeze.js";

// S1 (see engine.test.js): 24 h from 2026-09-19T00:00Z, rain 1 mm at index 15.
// Passing hours 6..11 and 18..19. With tz "UTC", index i is clock hour i on Saturday Sep 19 2026.
const S1_RULES = [
  { id: "temp", type: "range", metric: "temp", min: 10, max: 29 },
  { id: "dew", type: "dewMargin", min: 3 },
  { id: "wind", type: "range", metric: "wind", max: 25 },
  { id: "dry", type: "dry", before: 2, after: 3, maxMm: 0.1 },
  { id: "day", type: "daylight" },
];
const s1Hours = () => makeHours(24, { byIndex: { 15: { precip: 1.0 } } });

function build(minHours, extra = {}, hours = s1Hours(), rules = S1_RULES) {
  const evals = evaluateHours(hours, rules);
  const opts = { minHours, nowT: extra.nowT };
  const windows = findWindows(evals, opts);
  const nearMisses = findNearMisses(evals, opts);
  const input = { hours, evals, windows, nearMisses, tz: "UTC", locale: "en-US", units: "metric", rules, ...extra };
  return { vm: buildViewModel(input), input, evals, windows, nearMisses };
}

test("best window sentence for a known window (S1, 6..11)", () => {
  const { vm } = build(6);
  // window hours 6..11 cover 06:00 to 12:00, so the sentence ends at the end of hour 11
  assert.equal(vm.bestSentence, "Best window: Sat 6 AM to 12 PM (6 h)");
});

test("window crossing midnight names the end weekday", () => {
  const hours = makeHours(48);
  const evals = evaluateHours(hours, []);
  const w = { startIdx: 22, endIdx: 27, hours: 6, startT: hours[22].t, endT: hours[27].t };
  const vm = buildViewModel({ hours, evals, windows: [w], nearMisses: [], tz: "UTC", locale: "en-US", units: "metric" });
  assert.equal(vm.bestSentence, "Best window: Sat 10 PM to Sun 4 AM (6 h)");
});

test("windows list: chronological, one flagged best, each with a sentence", () => {
  const { vm } = build(2);
  assert.equal(vm.windows.length, 2);
  assert.deepEqual(vm.windows.map((w) => [w.startIdx, w.endIdx, w.hours, w.isBest]), [
    [6, 11, 6, true],
    [18, 19, 2, false],
  ]);
  assert.equal(vm.windows[1].sentence, "Sat 6 PM to 8 PM (2 h)");
  assert.equal(vm.windows[0].sentence, "Sat 6 AM to 12 PM (6 h)");
});

test("no window: names the closest near-miss and the rule holding it back", () => {
  const { vm, windows } = build(7);
  assert.equal(windows.length, 0);
  assert.match(vm.bestSentence, /^No window found/);
  assert.match(vm.bestSentence, /Closest miss/);
  assert.match(vm.bestSentence, /Daylight/); // 2..11: only daylight (4 h) holds it back, closer than dry (6 h)
  assert.equal(vm.nearMisses[0].blockingRuleId, "day");
});

test("no window, no near-miss: plain message; no data at all: says so", () => {
  const hours = makeHours(3, { all: { temp: 40 } });
  const evals = evaluateHours(hours, [{ id: "temp", type: "range", metric: "temp", max: 29 }]);
  const empty = buildViewModel({ hours, evals, windows: [], nearMisses: [], tz: "UTC", locale: "en-US", units: "metric" });
  assert.equal(empty.bestSentence, "No window found in this forecast.");
  const none = buildViewModel({ hours: [], evals: [], windows: [], nearMisses: [], tz: "UTC", locale: "en-US", units: "metric" });
  assert.equal(none.bestSentence, "No forecast data.");
  assert.deepEqual(none.days, []);
});

test("near-misses are ranked: fewest failing hours, then longest, then earliest", () => {
  const hours = makeHours(48);
  const evals = evaluateHours(hours, []);
  const nm = (startIdx, endIdx, blockingRuleId, failCount) => ({ startIdx, endIdx, hours: endIdx - startIdx + 1, blockingRuleId, failCount });
  const input = [nm(0, 7, "a", 5), nm(10, 17, "b", 2), nm(20, 29, "c", 2), nm(30, 37, "d", 2)];
  const vm = buildViewModel({ hours, evals, windows: [], nearMisses: input, tz: "UTC", locale: "en-US", units: "metric" });
  assert.deepEqual(vm.nearMisses.map((x) => x.blockingRuleId), ["c", "b", "d", "a"]);
  assert.equal(input[0].blockingRuleId, "a"); // caller's array untouched
});

test("near-miss sentence: range, blocker name, failing hours out of total", () => {
  const { vm } = build(6);
  assert.equal(vm.nearMisses.length, 1);
  assert.equal(vm.nearMisses[0].sentence, "Sat 12 PM to 8 PM: only Dry spell holds it back, for 6 of 8 h");
});

test("near-miss sentence: says 'all N h' when every hour in the run fails", () => {
  const hours = makeHours(6, { all: { wind: 40 } });
  const rules = [{ id: "wind", type: "range", metric: "wind", max: 25 }];
  const { vm } = build(3, {}, hours, rules);
  assert.equal(vm.nearMisses[0].sentence, "Sat 12 AM to 6 AM: only Wind speed holds it back, for all 6 h");
});

test("blocker falls back to the rule id when rules are not supplied", () => {
  const { input } = build(6);
  const { rules, ...noRules } = input;
  const vm = buildViewModel(noRules);
  assert.match(vm.nearMisses[0].sentence, /only dry holds it back/);
});

test("cell states: pass / near (exactly one fail) / fail / past", () => {
  const { vm } = build(6);
  const cells = vm.days.flatMap((d) => d.cells);
  const state = (i) => cells[i].state;
  assert.equal(state(0), "fail"); // dark + no-data
  assert.equal(state(1), "fail");
  assert.equal(state(3), "near"); // dark only
  assert.equal(state(6), "pass");
  assert.equal(state(11), "pass");
  assert.equal(state(13), "near"); // dry only
  assert.equal(state(18), "pass");
  assert.equal(state(22), "fail");
});

test("cells carry index, t, label, ambiguous, and enriched fails", () => {
  const { vm } = build(6);
  const cell = vm.days[0].cells[13];
  assert.equal(cell.i, 13);
  assert.equal(cell.t, START_T + 13 * 3600);
  assert.equal(cell.label, "1 PM");
  assert.equal(cell.ambiguous, false);
  assert.equal(cell.fails.length, 1);
  assert.equal(cell.fails[0].ruleId, "dry");
  assert.equal(cell.fails[0].kind, "wet");
  assert.equal(cell.fails[0].text, "Rain in dry window: 1 mm/h > 0.1 mm/h");
  assert.deepEqual(vm.days[0].cells[8].fails, []);
});

test("past cells are marked; the current hour is not past", () => {
  // 08:10Z on the 19th: hours 0..7 ended by 08:00, hour 8 is current
  const nowT = START_T + 8 * 3600 + 600;
  const { vm } = build(2, { nowT });
  const cells = vm.days[0].cells;
  for (let i = 0; i <= 7; i++) assert.equal(cells[i].state, "past", `i=${i}`);
  assert.equal(cells[8].state, "pass");
  // past hours can't be in a window, so the best window starts at the current hour
  assert.equal(vm.windows[0].startIdx, 8);
  assert.equal(vm.bestSentence, "Best window: Sat 8 AM to 12 PM (4 h)");
});

test("days: dateKey, label, cells grouped by local day", () => {
  const hours = makeHours(30);
  const evals = evaluateHours(hours, []);
  const vm = buildViewModel({ hours, evals, windows: [], nearMisses: [], tz: "UTC", locale: "en-US", units: "metric" });
  assert.deepEqual(vm.days.map((d) => [d.dateKey, d.cells.length]), [["2026-09-19", 24], ["2026-09-20", 6]]);
  assert.match(vm.days[0].label, /Sat/);
  assert.match(vm.days[0].label, /19/);
  assert.equal(vm.days[1].cells[0].i, 24);
});

function nyHours(t0, n) {
  return makeHours(n).map((h, i) => ({ ...h, t: t0 + i * 3600 }));
}

test("DST: cell counts per day match timefmt (23 on spring forward, 25 on fall back)", () => {
  for (const [t0, key, expected] of [
    [Date.UTC(2026, 2, 7, 5) / 1000, "2026-03-08", 23],
    [Date.UTC(2026, 9, 31, 4) / 1000, "2026-11-01", 25],
  ]) {
    const hours = nyHours(t0, 72);
    const evals = evaluateHours(hours, []);
    const vm = buildViewModel({ hours, evals, windows: [], nearMisses: [], tz: "America/New_York", locale: "en-US", units: "metric" });
    const counts = vm.days.map((d) => d.cells.length);
    assert.deepEqual(counts, groupByLocalDay(hours, "America/New_York").map((d) => d.cells.length));
    assert.equal(vm.days.find((d) => d.dateKey === key).cells.length, expected);
  }
});

test("DST fall back: the repeated hour is ambiguous and labeled with the zone", () => {
  const hours = nyHours(Date.UTC(2026, 9, 31, 4) / 1000, 72);
  const vm = buildViewModel({ hours, evals: evaluateHours(hours, []), windows: [], nearMisses: [], tz: "America/New_York", locale: "en-US", units: "metric" });
  const day = vm.days.find((d) => d.dateKey === "2026-11-01");
  assert.deepEqual(day.cells.slice(0, 4).map((c) => c.label), ["12 AM", "1 AM", "1 AM EST", "2 AM"]);
  assert.deepEqual(day.cells.slice(0, 4).map((c) => c.ambiguous), [false, false, true, false]);
});

test("imperial units change fail text only, not the structure", () => {
  const metric = build(6).vm;
  const imperial = build(6, { units: "imperial" }).vm;
  assert.equal(imperial.days[0].cells[13].fails[0].text, "Rain in dry window: 0.039 in/h > 0.004 in/h");
  assert.deepEqual(imperial.days.map((d) => d.cells.map((c) => [c.i, c.state])), metric.days.map((d) => d.cells.map((c) => [c.i, c.state])));
});

test("deterministic and pure: frozen inputs, same output twice", () => {
  const { input } = build(6);
  deepFreeze(input);
  const a = buildViewModel(input);
  const b = buildViewModel(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("mismatched hours/evals is a programmer error", () => {
  const hours = makeHours(3);
  assert.throws(() => buildViewModel({ hours, evals: [], windows: [], nearMisses: [], tz: "UTC", locale: "en-US", units: "metric" }), RangeError);
});
