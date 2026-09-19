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
