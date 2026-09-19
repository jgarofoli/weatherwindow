const BASE = "https://api.open-meteo.com/v1/forecast";

// API variable -> hour-record field, in request order.
const VARIABLES = [
  ["temperature_2m", "temp"],
  ["apparent_temperature", "apparent"],
  ["dew_point_2m", "dewPoint"],
  ["relative_humidity_2m", "rh"],
  ["precipitation", "precip"],
  ["precipitation_probability", "precipProb"],
  ["wind_speed_10m", "wind"],
  ["wind_gusts_10m", "gust"],
  ["uv_index", "uv"],
  ["cloud_cover", "cloud"],
  ["is_day", "isDay"],
];

// The only units the engine's canonical model can accept.
const REQUIRED_UNITS = {
  temperature_2m: "°C",
  apparent_temperature: "°C",
  dew_point_2m: "°C",
  wind_speed_10m: "km/h",
  wind_gusts_10m: "km/h",
  precipitation: "mm",
};

// Guards against a corrupt `time` array making us allocate millions of filler hours.
const MAX_GAP_HOURS = 24 * 16;

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParseError";
  }
}

export function buildForecastUrl({ lat, lon, horizonDays = 7 }) {
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: VARIABLES.map(([api]) => api).join(","),
    timeformat: "unixtime",
    timezone: "auto",
    forecast_days: String(horizonDays),
    past_days: "1",
    wind_speed_unit: "kmh",
    temperature_unit: "celsius",
    precipitation_unit: "mm",
  });
  // URLSearchParams encodes the hourly commas as %2C; both forms are equivalent.
  return `${BASE}?${p}`;
}

function missingHour(t) {
  const hour = { t, missing: true };
  for (const [, field] of VARIABLES) hour[field] = null;
  return hour;
}

export function parseForecast(json) {
  if (json === null || typeof json !== "object") throw new ParseError("response is not an object");
  const { hourly, hourly_units: units } = json;
  if (!hourly || typeof hourly !== "object") throw new ParseError("missing hourly block");
  if (!units || typeof units !== "object") throw new ParseError("missing hourly_units block");
  if (!Array.isArray(hourly.time)) throw new ParseError("missing hourly.time");

  const n = hourly.time.length;
  for (const [api] of VARIABLES) {
    if (!Array.isArray(hourly[api])) throw new ParseError(`missing variable ${api}`);
    if (hourly[api].length !== n) {
      throw new ParseError(`${api} has ${hourly[api].length} values but time has ${n}`);
    }
  }
  for (const [api, expected] of Object.entries(REQUIRED_UNITS)) {
    if (units[api] !== expected) {
      throw new ParseError(`unexpected unit for ${api}: ${JSON.stringify(units[api])} (expected ${expected})`);
    }
  }

  const hours = [];
  for (let i = 0; i < n; i++) {
    const t = hourly.time[i];
    if (!Number.isInteger(t)) throw new ParseError(`time[${i}] is not an integer epoch`);
    if (i > 0) {
      const prev = hours[hours.length - 1].t;
      const gap = t - prev;
      if (gap <= 0 || gap % 3600 !== 0) {
        throw new ParseError(`time[${i}] is not an increasing whole-hour step (gap ${gap}s)`);
      }
      if (gap / 3600 - 1 > MAX_GAP_HOURS) throw new ParseError(`time[${i}] follows an implausibly large gap`);
      for (let m = prev + 3600; m < t; m += 3600) hours.push(missingHour(m));
    }
    const hour = { t };
    for (const [api, field] of VARIABLES) hour[field] = hourly[api][i] ?? null;
    hour.missing = false;
    hours.push(hour);
  }

  return { tz: json.timezone ?? null, utcOffsetSeconds: json.utc_offset_seconds ?? null, hours };
}
