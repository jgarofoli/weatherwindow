// Captures real Open-Meteo responses into tests/fixtures/ (spec §11 M2, §14).
// Usage: npm run capture
// Output is a dated snapshot; commit it. Re-running overwrites.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");

const HOURLY = [
  "temperature_2m", "apparent_temperature", "dew_point_2m", "relative_humidity_2m",
  "precipitation", "precipitation_probability", "wind_speed_10m", "wind_gusts_10m",
  "uv_index", "cloud_cover", "is_day",
].join(",");

function forecastUrl(lat, lon, extra = "") {
  return (
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}&hourly=${HOURLY}` +
    "&timeformat=unixtime&timezone=auto&forecast_days=7&past_days=1" +
    "&wind_speed_unit=kmh&temperature_unit=celsius&precipitation_unit=mm" + extra
  );
}

const GEO = "https://geocoding-api.open-meteo.com/v1/search";

// name -> url. Spread of regions to probe null precipitation_probability / dew point.
const TARGETS = {
  "forecast-new-york": forecastUrl(40.71, -74.01),
  "forecast-denver": forecastUrl(39.74, -104.99),
  "forecast-sydney": forecastUrl(-33.87, 151.21),
  "forecast-reykjavik": forecastUrl(64.15, -21.94),
  "forecast-mid-pacific": forecastUrl(0, -160), // open ocean: sparse model coverage
  "geocode-springfield": `${GEO}?name=Springfield&count=8&language=en&format=json`,
  "geocode-empty": `${GEO}?name=zzzzqqqxx&count=8&language=en&format=json`,
  "error-bad-lat": forecastUrl(999, 0), // expect HTTP 400 + {error:true, reason}
  "error-bad-variable": forecastUrl(40.71, -74.01).replace("cloud_cover", "not_a_variable"),
};

await mkdir(OUT, { recursive: true });
const meta = { capturedAt: new Date().toISOString(), responses: {} };

for (const [name, url] of Object.entries(TARGETS)) {
  const res = await fetch(url);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { __nonJson: text }; }
  await writeFile(path.join(OUT, `${name}.json`), JSON.stringify(body, null, 1) + "\n");
  meta.responses[name] = {
    url,
    status: res.status,
    headers: Object.fromEntries(
      [...res.headers].filter(([k]) => /^(content-type|retry-after|x-ratelimit)/i.test(k)),
    ),
  };
  console.log(`${res.status} ${name}`);
}

await writeFile(path.join(OUT, "_meta.json"), JSON.stringify(meta, null, 1) + "\n");
