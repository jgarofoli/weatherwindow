import { test } from "node:test";
import assert from "node:assert/strict";
import { localParts, groupByLocalDay, hourLabel } from "../docs/lib/timefmt.js";

const NY = "America/New_York";
const utc = (y, m, d, h) => Date.UTC(y, m - 1, d, h) / 1000;
const hoursFrom = (t0, n) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 3600 }));

test("localParts: structured fields", () => {
  // 2026-09-19T04:00Z is 00:00 EDT (UTC-4); Sept 19 2026 is a Saturday.
  assert.deepEqual(localParts(utc(2026, 9, 19, 4), NY), {
    dateKey: "2026-09-19", year: 2026, month: 9, day: 19, hour: 0, minute: 0, weekday: 6,
  });
});

test("localParts: midnight is hour 0 (h23), never 24", () => {
  assert.equal(localParts(utc(2026, 9, 19, 4), NY).hour, 0);
  assert.equal(localParts(utc(2026, 9, 19, 3), NY).hour, 23);
  assert.equal(localParts(utc(2026, 9, 19, 3), NY).dateKey, "2026-09-18");
});

test("localParts: half-hour offset zone", () => {
  const p = localParts(utc(2026, 9, 19, 0), "Asia/Kolkata"); // UTC+5:30
  assert.equal(p.hour, 5);
  assert.equal(p.minute, 30);
});

test("spring forward 2026-03-08 (New York): local hours 0, 1, 3", () => {
  // 05:00Z = 00:00 EST, 06:00Z = 01:00 EST, 07:00Z = 03:00 EDT (02:00 does not exist)
  const hs = [5, 6, 7].map((h) => localParts(utc(2026, 3, 8, h), NY).hour);
  assert.deepEqual(hs, [0, 1, 3]);
});

test("spring forward day has 23 cells", () => {
  const days = groupByLocalDay(hoursFrom(utc(2026, 3, 7, 5), 72), NY); // starts 2026-03-07 00:00 EST
  const day = days.find((d) => d.dateKey === "2026-03-08");
  assert.equal(day.cells.length, 23);
  assert.deepEqual(day.cells.slice(0, 4).map((c) => c.hour), [0, 1, 3, 4]);
  assert.ok(day.cells.every((c) => !c.ambiguous));
});

test("fall back 2026-11-01 (New York): local hours 0, 1, 1, 2", () => {
  // 04:00Z = 00:00 EDT, 05:00Z = 01:00 EDT, 06:00Z = 01:00 EST, 07:00Z = 02:00 EST
  const hs = [4, 5, 6, 7].map((h) => localParts(utc(2026, 11, 1, h), NY).hour);
  assert.deepEqual(hs, [0, 1, 1, 2]);
});

test("fall back day has 25 cells; the second 1 AM is ambiguous", () => {
  const days = groupByLocalDay(hoursFrom(utc(2026, 10, 31, 4), 72), NY); // starts 2026-10-31 00:00 EDT
  const day = days.find((d) => d.dateKey === "2026-11-01");
  assert.equal(day.cells.length, 25);
  assert.deepEqual(day.cells.slice(0, 4).map((c) => c.hour), [0, 1, 1, 2]);
  assert.deepEqual(day.cells.map((c) => c.ambiguous).filter(Boolean).length, 1);
  assert.equal(day.cells[1].ambiguous, false);
  assert.equal(day.cells[2].ambiguous, true);
});

test("groupByLocalDay: ordinary days have 24 cells, index and t preserved, days in order", () => {
  const hours = hoursFrom(utc(2026, 9, 19, 4), 48 + 5);
  const days = groupByLocalDay(hours, NY);
  assert.deepEqual(days.map((d) => d.dateKey), ["2026-09-19", "2026-09-20", "2026-09-21"]);
  assert.deepEqual(days.map((d) => d.cells.length), [24, 24, 5]);
  assert.equal(days[0].weekday, 6);
  assert.equal(days[1].cells[0].i, 24);
  assert.equal(days[1].cells[0].t, hours[24].t);
  assert.equal(days[1].cells[0].hour, 0);
});

test("groupByLocalDay: empty input", () => {
  assert.deepEqual(groupByLocalDay([], NY), []);
});

test("hourLabel: smoke (formatted strings are ICU-dependent)", () => {
  assert.match(hourLabel(utc(2026, 9, 19, 19), NY, "en-US"), /\d{1,2}(:\d{2})?/);
  assert.match(hourLabel(utc(2026, 9, 19, 19), NY, "en-GB"), /\d{1,2}(:\d{2})?/);
});

test("hourLabel: ambiguous hour carries the tz abbreviation, and the two 1 AMs differ", () => {
  const first = hourLabel(utc(2026, 11, 1, 5), NY, "en-US", { ambiguous: true });
  const second = hourLabel(utc(2026, 11, 1, 6), NY, "en-US", { ambiguous: true });
  assert.match(first, /EDT/);
  assert.match(second, /EST/);
  assert.doesNotMatch(hourLabel(utc(2026, 9, 19, 19), NY, "en-US"), /EDT|EST/);
});

import { dayLabel } from "../docs/lib/timefmt.js";

test("hourLabel: no narrow no-break space, so sentences are stable across ICU versions", () => {
  const label = hourLabel(utc(2026, 9, 19, 19), NY, "en-US");
  assert.doesNotMatch(label, /[  ]/);
  assert.equal(label, "3 PM");
});

test("dayLabel: from calendar fields, independent of the runtime's timezone", () => {
  const parts = localParts(utc(2026, 9, 19, 4), NY); // Saturday Sep 19
  assert.equal(dayLabel(parts, "en-US", { weekday: "short" }), "Sat");
  const full = dayLabel(parts, "en-US");
  assert.match(full, /Sat/);
  assert.match(full, /19/);
});
