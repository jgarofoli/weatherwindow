// Engine output for every preset on every real fixture, pinned to tests/golden/*.json (spec §12).
// A diff here means engine, parser or preset behavior changed. Review it by eye, then regenerate with
// `npm run golden:update` (UPDATE_GOLDEN=1) and commit the golden diff together with the change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { PRESETS } from "../docs/lib/presets.js";
import { parseForecast } from "../docs/lib/forecast.js";
import { evaluateHours, findWindows, findNearMisses, pickBest } from "../docs/lib/engine.js";

const FIX = new URL("./fixtures/", import.meta.url);
const GOLDEN = new URL("./golden/", import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const CAPTURED_AT = Date.parse(JSON.parse(readFileSync(new URL("_meta.json", FIX), "utf8")).capturedAt) / 1000;
const NOW_T = Math.floor(CAPTURED_AT); // fixed, so goldens never depend on today's date

const fixtures = readdirSync(FIX).filter((f) => /^forecast-.+\.json$/.test(f)).sort();

// One char per hour: "P" passes, a digit is how many rules fail (9 = nine or more).
const pattern = (evals) => evals.map((e) => (e.pass ? "P" : String(Math.min(9, e.fails.length)))).join("");

function run(fixtureFile, preset) {
  const { hours } = parseForecast(JSON.parse(readFileSync(new URL(fixtureFile, FIX), "utf8")));
  const { minHours, rules } = preset.ruleSet;
  const evals = evaluateHours(hours, rules);
  const opts = { minHours, nowT: NOW_T };
  const windows = findWindows(evals, opts);
  return {
    fixture: fixtureFile,
    preset: preset.id,
    nowT: NOW_T,
    minHours,
    hours: hours.length,
    pattern: pattern(evals),
    windows,
    best: pickBest(windows),
    nearMisses: findNearMisses(evals, opts),
  };
}

for (const f of fixtures) {
  for (const preset of PRESETS) {
    const name = `${f.replace(/^forecast-|\.json$/g, "")}--${preset.id}.json`;
    test(`golden: ${preset.id} on ${f}`, () => {
      const actual = run(f, preset);
      const file = new URL(name, GOLDEN);
      if (UPDATE) {
        mkdirSync(GOLDEN, { recursive: true });
        writeFileSync(file, JSON.stringify(actual, null, 1) + "\n");
        return;
      }
      assert.ok(existsSync(file), `missing tests/golden/${name}. Run: npm run golden:update`);
      assert.deepEqual(actual, JSON.parse(readFileSync(file, "utf8")),
        `golden mismatch for ${name}. If the change is intended: npm run golden:update, then review the diff.`);
    });
  }
}

test("goldens exist for exactly the fixtures x presets (no stale files)", { skip: UPDATE }, () => {
  const expected = fixtures.flatMap((f) => PRESETS.map((p) => `${f.replace(/^forecast-|\.json$/g, "")}--${p.id}.json`)).sort();
  assert.deepEqual(readdirSync(GOLDEN).sort(), expected);
});
