import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildGeocodeUrl, normalizeGeocode, roundCoord } from "../docs/lib/geo.js";

const SPRINGFIELD = JSON.parse(readFileSync(new URL("./fixtures/geocode-springfield.json", import.meta.url), "utf8"));
const EMPTY = JSON.parse(readFileSync(new URL("./fixtures/geocode-empty.json", import.meta.url), "utf8"));

test("roundCoord: rounds to the requested decimals", () => {
  assert.equal(roundCoord(40.7128, 2), 40.71);
  assert.equal(roundCoord(-74.006, 2), -74.01);
  assert.equal(roundCoord(1.005, 2), 1.01);
  assert.equal(roundCoord(12.3456, 0), 12);
});

test("roundCoord: never returns -0", () => {
  assert.ok(Object.is(roundCoord(-0.001, 2), 0));
});

test("buildGeocodeUrl: fewer than 3 characters -> null (whitespace does not count)", () => {
  assert.equal(buildGeocodeUrl(""), null);
  assert.equal(buildGeocodeUrl("ab"), null);
  assert.equal(buildGeocodeUrl("  ab  "), null);
  assert.equal(buildGeocodeUrl(undefined), null);
  assert.equal(buildGeocodeUrl(null), null);
  assert.notEqual(buildGeocodeUrl("abc"), null);
});

test("buildGeocodeUrl: host, query, defaults and overrides", () => {
  const u = new URL(buildGeocodeUrl("  New York "));
  assert.equal(u.origin, "https://geocoding-api.open-meteo.com");
  assert.equal(u.pathname, "/v1/search");
  assert.equal(u.searchParams.get("name"), "New York");
  assert.equal(u.searchParams.get("count"), "8");
  assert.equal(u.searchParams.get("language"), "en");
  assert.equal(u.searchParams.get("format"), "json");
  const o = new URL(buildGeocodeUrl("Paris", { count: 3, language: "fr" }));
  assert.equal(o.searchParams.get("count"), "3");
  assert.equal(o.searchParams.get("language"), "fr");
});

test("buildGeocodeUrl: hostile text is encoded, not interpreted; very long input is capped", () => {
  const u = new URL(buildGeocodeUrl("a&count=999#x"));
  assert.equal(u.searchParams.get("name"), "a&count=999#x");
  assert.equal(u.searchParams.get("count"), "8");
  assert.ok(new URL(buildGeocodeUrl("x".repeat(500))).searchParams.get("name").length <= 100);
});

test("normalizeGeocode: a response with no results key -> [] (real 'no match' payload)", () => {
  assert.equal("results" in EMPTY, false);
  assert.deepEqual(normalizeGeocode(EMPTY), []);
  assert.deepEqual(normalizeGeocode({}), []);
  assert.deepEqual(normalizeGeocode(null), []);
  assert.deepEqual(normalizeGeocode({ results: "nope" }), []);
});

test("normalizeGeocode: maps the real Open-Meteo shape", () => {
  const r = normalizeGeocode(SPRINGFIELD);
  assert.equal(r.length, 8);
  assert.deepEqual(r[1], {
    id: "4250542",
    name: "Springfield",
    admin1: "Illinois",
    country: "United States",
    countryCode: "US",
    lat: 39.80172,
    lon: -89.64371,
    tz: "America/Chicago",
    label: "Springfield, Illinois, United States",
  });
});

test("normalizeGeocode: same-name results keep distinct ids and labels stay distinguishable", () => {
  const r = normalizeGeocode(SPRINGFIELD).filter((x) => x.name === "Springfield");
  assert.ok(r.length >= 4);
  assert.equal(new Set(r.map((x) => x.id)).size, r.length);
  assert.equal(new Set(r.map((x) => x.label)).size, r.length);
});

test("normalizeGeocode: missing region/country are skipped, not printed as 'undefined'; adjacent duplicates collapse", () => {
  const r = normalizeGeocode({
    results: [
      { id: 1, name: "Nowhere", latitude: 1, longitude: 2, country: "Testland" },
      { id: 2, name: "Singapore", admin1: "Singapore", country: "Singapore", latitude: 1.29, longitude: 103.85, timezone: "Asia/Singapore" },
      { id: 3, name: "Bare", latitude: 5, longitude: 6 },
    ],
  });
  assert.deepEqual(r.map((x) => x.label), ["Nowhere, Testland", "Singapore", "Bare"]);
  assert.equal(r[0].tz, null);
  assert.equal(r[0].admin1, null);
});

test("normalizeGeocode: drops entries without usable coordinates, keeps the rest; input untouched", () => {
  const input = Object.freeze({
    results: Object.freeze([
      Object.freeze({ id: 1, name: "Good", latitude: 10, longitude: 20 }),
      Object.freeze({ id: 2, name: "NoCoords" }),
      Object.freeze({ id: 3, name: "BadLat", latitude: 999, longitude: 0 }),
      null,
    ]),
  });
  assert.deepEqual(normalizeGeocode(input).map((x) => x.name), ["Good"]);
});

test("normalizeGeocode: an entry without an id gets a stable synthetic one", () => {
  const [a] = normalizeGeocode({ results: [{ name: "X", latitude: 1.5, longitude: 2.5 }] });
  const [b] = normalizeGeocode({ results: [{ name: "X", latitude: 1.5, longitude: 2.5 }] });
  assert.ok(a.id.length > 0);
  assert.equal(a.id, b.id);
});
