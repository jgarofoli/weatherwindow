import { test } from "node:test";
import assert from "node:assert/strict";
import { cToF, fToC, kmhToMph, mphToKmh, mmToIn, inToMm } from "../docs/lib/units.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("known values", () => {
  near(cToF(10), 50);
  near(cToF(-40), -40);
  near(fToC(212), 100);
  near(kmhToMph(1.609344), 1);
  near(mphToKmh(1), 1.609344);
  near(mmToIn(25.4), 1);
  near(inToMm(1), 25.4);
});

test("round trips within 1e-9", () => {
  for (const x of [-40, -0.3, 0, 0.1, 12.3456, 29, 100.5]) {
    near(fToC(cToF(x)), x);
    near(cToF(fToC(x)), x);
    near(mphToKmh(kmhToMph(x)), x);
    near(kmhToMph(mphToKmh(x)), x);
    near(inToMm(mmToIn(x)), x);
    near(mmToIn(inToMm(x)), x);
  }
});

import { unitLabel, toDisplay, fromDisplay, formatNum } from "../docs/lib/units.js";

test("unit kinds: labels", () => {
  assert.equal(unitLabel("temp", "metric"), "°C");
  assert.equal(unitLabel("temp", "imperial"), "°F");
  assert.equal(unitLabel("tempDelta", "imperial"), "°F");
  assert.equal(unitLabel("speed", "metric"), "km/h");
  assert.equal(unitLabel("speed", "imperial"), "mph");
  assert.equal(unitLabel("precip", "metric"), "mm");
  assert.equal(unitLabel("precip", "imperial"), "in");
  assert.equal(unitLabel("pct", "imperial"), "%");
  assert.equal(unitLabel("uv", "metric"), "");
});

test("toDisplay/fromDisplay: temp uses offset, tempDelta does not", () => {
  near(toDisplay("temp", 10, "imperial"), 50);
  near(fromDisplay("temp", 50, "imperial"), 10);
  near(toDisplay("tempDelta", 3, "imperial"), 5.4); // a 3 °C difference is 5.4 °F, not 37.4
  near(fromDisplay("tempDelta", 5.4, "imperial"), 3);
  near(toDisplay("temp", 10, "metric"), 10);
});

test("toDisplay/fromDisplay: speed, precip, pct, uv", () => {
  near(toDisplay("speed", 1.609344, "imperial"), 1);
  near(fromDisplay("precip", 1, "imperial"), 25.4);
  near(toDisplay("pct", 85, "imperial"), 85);
  near(toDisplay("uv", 8, "imperial"), 8);
});

test("toDisplay/fromDisplay round trip", () => {
  for (const kind of ["temp", "tempDelta", "speed", "precip", "pct", "uv"]) {
    for (const v of [0, 0.1, 3, 12.5, 85]) {
      near(fromDisplay(kind, toDisplay(kind, v, "imperial"), "imperial"), v);
    }
  }
});

test("formatNum: rounds, strips trailing zeros, never prints -0", () => {
  assert.equal(formatNum(84.2000001, 1), "84.2");
  assert.equal(formatNum(10, 1), "10");
  assert.equal(formatNum(15.534, 1), "15.5");
  assert.equal(formatNum(0.0039370, 3), "0.004");
  assert.equal(formatNum(-0.0001, 1), "0");
});
