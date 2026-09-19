import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildForecastUrl, parseForecast, ParseError } from "../docs/lib/forecast.js";
import { localParts } from "../docs/lib/timefmt.js";
import { evaluateHours } from "../docs/lib/engine.js";

const FIX = new URL("./fixtures/", import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, FIX), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

const NY = load("forecast-new-york.json");
const FORECASTS = readdirSync(FIX).filter((f) => f.startsWith("forecast-"));

test("buildForecastUrl: spec §5 query", () => {
  const u = new URL(buildForecastUrl({ lat: 40.71, lon: -74.01, horizonDays: 7 }));
  assert.equal(u.origin, "https://api.open-meteo.com");
  assert.equal(u.pathname, "/v1/forecast");
  const p = u.searchParams;
  assert.equal(p.get("latitude"), "40.71");
  assert.equal(p.get("longitude"), "-74.01");
  assert.equal(
    p.get("hourly"),
    "temperature_2m,apparent_temperature,dew_point_2m,relative_humidity_2m,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,uv_index,cloud_cover,is_day",
  );
  assert.equal(p.get("timeformat"), "unixtime");
  assert.equal(p.get("timezone"), "auto");
  assert.equal(p.get("forecast_days"), "7");
  assert.equal(p.get("past_days"), "1");
  assert.equal(p.get("wind_speed_unit"), "kmh");
  assert.equal(p.get("temperature_unit"), "celsius");
  assert.equal(p.get("precipitation_unit"), "mm");
});

test("buildForecastUrl: horizon is honored", () => {
  const u = new URL(buildForecastUrl({ lat: 1, lon: 2, horizonDays: 14 }));
  assert.equal(u.searchParams.get("forecast_days"), "14");
});

test("real fixture: length, first t, tz, offset", () => {
  const f = parseForecast(NY);
  assert.equal(f.tz, "America/New_York");
  assert.equal(f.utcOffsetSeconds, -14400);
  assert.equal(f.hours.length, 8 * 24); // past_days=1 + forecast_days=7
  assert.equal(f.hours[0].t, NY.hourly.time[0]);
  assert.equal(f.hours[0].missing, false);
});

test("real fixtures: hourly and contiguous; past_days=1 starts at local midnight", () => {
  for (const name of FORECASTS) {
    const raw = load(name);
    const f = parseForecast(raw);
    assert.equal(f.hours.length, 192, name);
    assert.ok(f.hours.every((h) => !h.missing), `${name} has gaps`);
    for (let i = 1; i < f.hours.length; i++) {
      assert.equal(f.hours[i].t - f.hours[i - 1].t, 3600, name);
    }
    assert.equal(localParts(f.hours[0].t, f.tz).hour, 0, `${name} first hour is local midnight`);
  }
});

test("M2 kill/pivot check: dew point and precip probability are populated on real fixtures", () => {
  for (const name of FORECASTS) {
    const { hours } = parseForecast(load(name));
    assert.ok(hours.every((h) => h.dewPoint !== null), `${name} dewPoint null`);
    assert.ok(hours.every((h) => h.precipProb !== null), `${name} precipProb null`);
  }
});

test("hour record maps every field, isDay is 0|1", () => {
  const { hours } = parseForecast(NY);
  const h = hours[10];
  const i = 10;
  assert.deepEqual(h, {
    t: NY.hourly.time[i],
    temp: NY.hourly.temperature_2m[i],
    apparent: NY.hourly.apparent_temperature[i],
    dewPoint: NY.hourly.dew_point_2m[i],
    rh: NY.hourly.relative_humidity_2m[i],
    precip: NY.hourly.precipitation[i],
    precipProb: NY.hourly.precipitation_probability[i],
    wind: NY.hourly.wind_speed_10m[i],
    gust: NY.hourly.wind_gusts_10m[i],
    uv: NY.hourly.uv_index[i],
    cloud: NY.hourly.cloud_cover[i],
    isDay: NY.hourly.is_day[i],
    missing: false,
  });
  assert.ok(hours.every((x) => x.isDay === 0 || x.isDay === 1));
});

test("nulls are preserved, not coerced to 0", () => {
  const raw = clone(NY);
  raw.hourly.temperature_2m[3] = null;
  raw.hourly.is_day[4] = null;
  raw.hourly.precipitation_probability[5] = null;
  const { hours } = parseForecast(raw);
  assert.equal(hours[3].temp, null);
  assert.equal(hours[4].isDay, null);
  assert.equal(hours[5].precipProb, null);
  assert.equal(hours[3].missing, false);
});

test("missing variable throws ParseError naming it", () => {
  const raw = clone(NY);
  delete raw.hourly.dew_point_2m;
  assert.throws(() => parseForecast(raw), (e) => e instanceof ParseError && /dew_point_2m/.test(e.message));
});

test("missing hourly/time throws ParseError", () => {
  assert.throws(() => parseForecast({}), ParseError);
  assert.throws(() => parseForecast(null), ParseError);
  const raw = clone(NY);
  delete raw.hourly.time;
  assert.throws(() => parseForecast(raw), ParseError);
});

test("unequal array lengths throw ParseError naming the variable", () => {
  const raw = clone(NY);
  raw.hourly.wind_speed_10m.pop();
  assert.throws(() => parseForecast(raw), (e) => e instanceof ParseError && /wind_speed_10m/.test(e.message));
});

test("hourly_units mismatch throws ParseError", () => {
  for (const [key, bad] of [
    ["temperature_2m", "°F"],
    ["apparent_temperature", "°F"],
    ["dew_point_2m", "°F"],
    ["wind_speed_10m", "mp/h"],
    ["wind_gusts_10m", "m/s"],
    ["precipitation", "inch"],
  ]) {
    const raw = clone(NY);
    raw.hourly_units[key] = bad;
    assert.throws(
      () => parseForecast(raw),
      (e) => e instanceof ParseError && e.message.includes(key),
      `${key} -> ${bad}`,
    );
  }
});

test("missing hourly_units throws ParseError", () => {
  const raw = clone(NY);
  delete raw.hourly_units;
  assert.throws(() => parseForecast(raw), ParseError);
});

test("a gap in time yields missing hours with all metrics null", () => {
  const raw = clone(NY);
  const cut = 20;
  const dropped = 3;
  for (const k of Object.keys(raw.hourly)) raw.hourly[k].splice(cut, dropped);
  const { hours } = parseForecast(raw);
  assert.equal(hours.length, 192); // gap refilled
  for (let i = 1; i < hours.length; i++) assert.equal(hours[i].t - hours[i - 1].t, 3600);
  for (let i = cut; i < cut + dropped; i++) {
    assert.equal(hours[i].missing, true);
    assert.equal(hours[i].t, NY.hourly.time[i]);
    for (const k of ["temp", "apparent", "dewPoint", "rh", "precip", "precipProb", "wind", "gust", "uv", "cloud", "isDay"]) {
      assert.equal(hours[i][k], null, k);
    }
  }
  assert.equal(hours[cut + dropped].missing, false);
});

test("non-increasing or non-hour-aligned time throws ParseError", () => {
  const dup = clone(NY);
  dup.hourly.time[5] = dup.hourly.time[4];
  assert.throws(() => parseForecast(dup), ParseError);
  const odd = clone(NY);
  odd.hourly.time[5] += 1800;
  assert.throws(() => parseForecast(odd), ParseError);
});

test("parsed real hours feed the engine without throwing", () => {
  const { hours } = parseForecast(NY);
  const evals = evaluateHours(hours, [
    { id: "temp", type: "range", metric: "temp", min: 10, max: 29 },
    { id: "dew", type: "dewMargin", min: 3 },
    { id: "dry", type: "dry", before: 4, after: 8, maxMm: 0.1, maxProb: 30 },
    { id: "day", type: "daylight" },
  ]);
  assert.equal(evals.length, hours.length);
});
