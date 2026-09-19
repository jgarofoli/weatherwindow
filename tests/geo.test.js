import { test } from "node:test";
import assert from "node:assert/strict";
import { roundCoord } from "../docs/lib/geo.js";

// M3 covers roundCoord only (urlstate depends on it); the rest of geo.js lands in M6.
test("roundCoord: rounds to the requested decimals", () => {
  assert.equal(roundCoord(40.7128, 2), 40.71);
  assert.equal(roundCoord(-74.006, 2), -74.01);
  assert.equal(roundCoord(1.005, 2), 1.01);
  assert.equal(roundCoord(12.3456, 0), 12);
});

test("roundCoord: never returns -0", () => {
  assert.ok(Object.is(roundCoord(-0.001, 2), 0));
});
