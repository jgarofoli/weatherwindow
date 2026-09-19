import { validateRuleSet } from "./rules.js";
import { clonePreset, DEFAULT_PRESET_ID } from "./presets.js";
import { roundCoord } from "./geo.js";

const VERSION = 1;
const NAME_MAX = 80;
const MAX_HASH_LENGTH = 8000; // real hashes are well under 2000; refuse anything absurd before parsing
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const B64URL = /^[A-Za-z0-9_-]*$/;

export const defaultState = () => ({ loc: null, units: "metric", ruleSet: clonePreset(DEFAULT_PRESET_ID) });

// The name is untrusted display text. Rendering safety is textContent's job; this just bounds it.
function sanitizeName(s) {
  const wellFormed = typeof s.toWellFormed === "function" ? s.toWellFormed() : s;
  return Array.from(wellFormed.replace(CONTROL_CHARS, "")).slice(0, NAME_MAX).join("").trim();
}

function toB64url(str) {
  let bin = "";
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  if (!B64URL.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const validCoord = (s, limit) => {
  if (s === null || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) <= limit ? roundCoord(n, 2) : null;
};

// -> "#v=1&lat=..&lon=..&n=..&u=metric&r=<base64url(JSON)>". An invalid ruleSet is left out
// (so a half-typed edit never breaks the URL); decoding then falls back to the default rules.
export function encodeState({ loc, units, ruleSet }) {
  const p = new URLSearchParams({ v: String(VERSION) });
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    p.set("lat", String(roundCoord(loc.lat, 2)));
    p.set("lon", String(roundCoord(loc.lon, 2)));
    const name = sanitizeName(String(loc.name ?? ""));
    if (name) p.set("n", name);
  }
  p.set("u", units === "imperial" ? "imperial" : "metric");
  const checked = validateRuleSet(ruleSet);
  if (checked.ok) p.set("r", toB64url(JSON.stringify(checked.value)));
  return `#${p}`;
}

// Never throws. Anything unreadable falls back to defaults and adds a warning.
export function decodeState(hash) {
  const state = defaultState();
  const warnings = [];
  try {
    if (hash === undefined || hash === null) return { state, warnings };
    if (typeof hash !== "string") return { state, warnings: ["Link is not text."] };
    const str = hash.startsWith("#") ? hash.slice(1) : hash;
    if (str === "") return { state, warnings };
    if (str.length > MAX_HASH_LENGTH) return { state, warnings: ["Link is too long to read."] };

    const p = new URLSearchParams(str);
    if (p.get("v") !== String(VERSION)) return { state, warnings: ["Unsupported or missing link version."] };

    const latS = p.get("lat");
    const lonS = p.get("lon");
    if (latS !== null || lonS !== null) {
      const lat = validCoord(latS, 90);
      const lon = validCoord(lonS, 180);
      if (lat === null || lon === null) {
        warnings.push("Location in link is invalid.");
      } else {
        state.loc = { name: sanitizeName(p.get("n") ?? "") || `${lat}, ${lon}`, lat, lon };
      }
    }

    const u = p.get("u");
    if (u === "imperial" || u === "metric") state.units = u;
    else if (u !== null) warnings.push("Units in link are invalid.");

    const r = p.get("r");
    if (r !== null) {
      try {
        const checked = validateRuleSet(JSON.parse(fromB64url(r)));
        if (checked.ok) state.ruleSet = checked.value;
        else warnings.push("Rules in link are invalid.");
      } catch {
        warnings.push("Rules in link could not be read.");
      }
    }
  } catch {
    return { state: defaultState(), warnings: ["Link could not be read."] };
  }
  return { state, warnings };
}
