import { roundTo } from "./units.js";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const MIN_QUERY = 3;
const MAX_QUERY = 100;

export const roundCoord = (x, decimals = 2) => roundTo(x, decimals);

// null when the query is too short to search (keeps us well under the free tier's rate limits).
export function buildGeocodeUrl(q, { count = 8, language = "en" } = {}) {
  const s = typeof q === "string" ? q.trim() : "";
  if (s.length < MIN_QUERY) return null;
  const p = new URLSearchParams({ name: s.slice(0, MAX_QUERY), count: String(count), language, format: "json" });
  return `${GEOCODE_URL}?${p}`;
}

const text = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);
const inRange = (v, limit) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit;

// "No match" comes back as an object with no `results` key (confirmed on a real capture).
export function normalizeGeocode(json) {
  const results = json && Array.isArray(json.results) ? json.results : [];
  const out = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const name = text(r.name);
    if (!name || !inRange(r.latitude, 90) || !inRange(r.longitude, 180)) continue;
    const parts = [name, text(r.admin1), text(r.country)].filter(Boolean);
    const label = parts.filter((p, i) => i === 0 || p !== parts[i - 1]).join(", ");
    out.push({
      id: r.id !== undefined && r.id !== null ? String(r.id) : `${name}:${r.latitude},${r.longitude}`,
      name,
      admin1: text(r.admin1),
      country: text(r.country),
      countryCode: text(r.country_code),
      lat: r.latitude,
      lon: r.longitude,
      tz: text(r.timezone),
      label,
    });
  }
  return out;
}
