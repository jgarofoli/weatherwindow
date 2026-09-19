// Display-only conversions. Canonical storage is °C, km/h, mm; never round here.
const KMH_PER_MPH = 1.609344;
const MM_PER_IN = 25.4;

export const cToF = (c) => (c * 9) / 5 + 32;
export const fToC = (f) => ((f - 32) * 5) / 9;
export const kmhToMph = (k) => k / KMH_PER_MPH;
export const mphToKmh = (m) => m * KMH_PER_MPH;
export const mmToIn = (mm) => mm / MM_PER_IN;
export const inToMm = (i) => i * MM_PER_IN;

// --- Unit kinds: what a stored (canonical) number *is*, so display code knows how to convert it.
// tempDelta is a temperature difference (e.g. dew-point margin): scaled, but no +32 offset.
const KINDS = {
  temp: { metric: "°C", imperial: "°F", to: cToF, from: fToC, decimals: { metric: 1, imperial: 1 } },
  tempDelta: {
    metric: "°C", imperial: "°F",
    to: (c) => (c * 9) / 5, from: (f) => (f * 5) / 9,
    decimals: { metric: 1, imperial: 1 },
  },
  speed: { metric: "km/h", imperial: "mph", to: kmhToMph, from: mphToKmh, decimals: { metric: 1, imperial: 1 } },
  // Imperial needs 3 decimals or the 0.1 mm default reads as "0.00 in".
  precip: { metric: "mm", imperial: "in", to: mmToIn, from: inToMm, decimals: { metric: 2, imperial: 3 } },
  pct: { metric: "%", imperial: "%", decimals: { metric: 1, imperial: 1 } },
  uv: { metric: "", imperial: "", decimals: { metric: 1, imperial: 1 } },
};

const kindOf = (kind) => {
  const k = KINDS[kind];
  if (!k) throw new TypeError(`Unknown unit kind: ${kind}`);
  return k;
};

export const unitLabel = (kind, units) => kindOf(kind)[units === "imperial" ? "imperial" : "metric"];

export function toDisplay(kind, value, units) {
  const k = kindOf(kind);
  return units === "imperial" && k.to ? k.to(value) : value;
}

export function fromDisplay(kind, value, units) {
  const k = kindOf(kind);
  return units === "imperial" && k.from ? k.from(value) : value;
}

// Rounds via exponent shifting so 1.005 -> 1.01 (Math.round(1.005 * 100) gives 1). Never returns -0.
export function roundTo(x, decimals) {
  if (!Number.isFinite(x)) return x;
  const shifted = Math.round(Number(`${x}e${decimals}`));
  const r = Number(`${shifted}e-${decimals}`);
  return Number.isNaN(r) ? Math.round(x * 10 ** decimals) / 10 ** decimals || 0 : r || 0;
}

// Display string for a number: rounded to at most `decimals`, trailing zeros dropped.
export const formatNum = (x, decimals) => String(roundTo(x, decimals));

// Canonical value -> rounded display number for `kind`. Display only; never store the result.
export const displayNumber = (kind, value, units) =>
  formatNum(toDisplay(kind, value, units), kindOf(kind).decimals[units === "imperial" ? "imperial" : "metric"]);
