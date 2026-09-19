import { displayNumber, unitLabel } from "./units.js";

export const RULE_TYPES = Object.freeze(["range", "dewMargin", "dry", "daylight"]);

// metric -> label and unit kind. Order is the order the UI offers them in.
export const METRICS = Object.freeze({
  temp: { label: "Air temperature", kind: "temp" },
  apparent: { label: "Feels-like temperature", kind: "temp" },
  rh: { label: "Humidity", kind: "pct" },
  wind: { label: "Wind speed", kind: "speed" },
  gust: { label: "Wind gusts", kind: "speed" },
  precipProb: { label: "Rain chance", kind: "pct" },
  uv: { label: "UV index", kind: "uv" },
  cloud: { label: "Cloud cover", kind: "pct" },
});

export const MAX_RULES = 20;
export const HORIZONS = Object.freeze([3, 7, 14]);
const MAX_ID_LENGTH = 40;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
const show = (v) => JSON.stringify(String(v).slice(0, MAX_ID_LENGTH));

function validateRule(raw, seenIds, errors) {
  if (!isObj(raw)) {
    errors.push("each rule must be an object");
    return null;
  }
  const n0 = errors.length;
  const label = typeof raw.id === "string" && raw.id ? `rule ${show(raw.id)}` : "a rule";

  if (typeof raw.id !== "string" || raw.id === "" || raw.id.length > MAX_ID_LENGTH) {
    errors.push(`${label}: id must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
  } else if (seenIds.has(raw.id)) {
    errors.push(`${label}: duplicate id`);
  } else {
    seenIds.add(raw.id);
  }

  const rule = { id: raw.id, type: raw.type };
  switch (raw.type) {
    case "range": {
      if (!Object.hasOwn(METRICS, raw.metric)) {
        errors.push(`${label}: unknown metric ${show(raw.metric)}`);
        break;
      }
      rule.metric = raw.metric;
      for (const bound of ["min", "max"]) {
        const v = raw[bound];
        if (v === undefined || v === null) continue;
        if (!isNum(v)) errors.push(`${label}: ${bound} must be a finite number`);
        else rule[bound] = v;
      }
      if (errors.length === n0) {
        if (rule.min === undefined && rule.max === undefined) errors.push(`${label}: needs a min or a max`);
        else if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) {
          errors.push(`${label}: min (${rule.min}) is greater than max (${rule.max})`);
        }
      }
      break;
    }
    case "dewMargin":
      if (!isNum(raw.min)) errors.push(`${label}: min must be a finite number`);
      else rule.min = raw.min;
      break;
    case "dry": {
      for (const side of ["before", "after"]) {
        const v = raw[side] ?? 0;
        if (!isNum(v)) errors.push(`${label}: ${side} must be a number`);
        else rule[side] = clampInt(v, 0, 24);
      }
      if (!isNum(raw.maxMm) || raw.maxMm < 0) errors.push(`${label}: maxMm must be a number >= 0`);
      else rule.maxMm = raw.maxMm;
      const p = raw.maxProb ?? null;
      if (p !== null && (!isNum(p) || p < 0 || p > 100)) errors.push(`${label}: maxProb must be null or 0 to 100`);
      else rule.maxProb = p;
      break;
    }
    case "daylight":
      break;
    default:
      errors.push(`${label}: unknown type ${show(raw.type)}`);
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") errors.push(`${label}: enabled must be true or false`);
    else rule.enabled = raw.enabled;
  }
  return errors.length === n0 ? rule : null;
}

// Returns { ok, errors, value }. `value` is a normalized copy (unknown fields dropped, dry
// before/after clamped and rounded, minHours clamped to 1..24), or null when not ok. Input is not mutated.
export function validateRuleSet(obj) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: ["rule set must be an object"], value: null };

  if (obj.v !== 1) errors.push(`unsupported rule set version ${show(obj.v)}`);

  let minHours = null;
  if (!isNum(obj.minHours)) errors.push("minHours must be a number");
  else minHours = clampInt(obj.minHours, 1, 24);

  let horizonDays = 7;
  if (obj.horizonDays !== undefined) {
    if (!HORIZONS.includes(obj.horizonDays)) errors.push(`horizonDays must be one of ${HORIZONS.join(", ")}`);
    else horizonDays = obj.horizonDays;
  }

  const rules = [];
  if (!Array.isArray(obj.rules)) {
    errors.push("rules must be an array");
  } else if (obj.rules.length > MAX_RULES) {
    errors.push(`too many rules (${obj.rules.length}); the limit is ${MAX_RULES}`);
  } else {
    const seenIds = new Set();
    for (const raw of obj.rules) {
      const rule = validateRule(raw, seenIds, errors);
      if (rule) rules.push(rule);
    }
  }

  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors, value: { v: 1, minHours, horizonDays, rules } };
}

const withUnit = (num, label) => (label === "%" ? `${num}%` : label ? `${num} ${label}` : num);

// Sentence for a (valid) rule in the given display units. Thresholds stay canonical; only the text converts.
export function describeRule(rule, units = "metric") {
  switch (rule.type) {
    case "range": {
      const m = METRICS[rule.metric];
      if (!m) throw new TypeError(`Unknown metric: ${rule.metric}`);
      const u = unitLabel(m.kind, units);
      const fmt = (v) => displayNumber(m.kind, v, units);
      if (rule.min !== undefined && rule.max !== undefined) {
        return `${m.label} between ${fmt(rule.min)} and ${withUnit(fmt(rule.max), u)}`;
      }
      if (rule.min !== undefined) return `${m.label} at least ${withUnit(fmt(rule.min), u)}`;
      return `${m.label} at most ${withUnit(fmt(rule.max), u)}`;
    }
    case "dewMargin":
      return `${METRICS.temp.label} at least ${withUnit(displayNumber("tempDelta", rule.min, units), unitLabel("tempDelta", units))} above dew point`;
    case "dry": {
      const rate = `${displayNumber("precip", rule.maxMm, units)} ${unitLabel("precip", units)}/h`;
      const prob = rule.maxProb === null || rule.maxProb === undefined ? "" : ` and ${rule.maxProb}% rain chance`;
      const before = rule.before ?? 0;
      const after = rule.after ?? 0;
      let span = "";
      if (before > 0 && after > 0) span = ` from ${before} h before to ${after} h after`;
      else if (after > 0) span = ` through ${after} h after`;
      else if (before > 0) span = ` from ${before} h before`;
      return `Dry (at most ${rate}${prob})${span}`;
    }
    case "daylight":
      return "During daylight";
    default:
      throw new TypeError(`Unknown rule type: ${rule.type}`);
  }
}

// Short name for headings and "held back by ..." sentences.
export function ruleName(rule) {
  switch (rule.type) {
    case "range":
      return METRICS[rule.metric]?.label ?? rule.id;
    case "dewMargin":
      return "Dew-point margin";
    case "dry":
      return "Dry spell";
    case "daylight":
      return "Daylight";
    default:
      return rule.id;
  }
}

// One failing hour, as "value vs limit" text. `rule` may be undefined (e.g. a link whose rules were
// dropped); then we fall back to the id and kind rather than throw.
export function describeFail(fail, rule, units = "metric") {
  if (!rule) return `${fail.ruleId}: ${fail.kind}`;
  const name = ruleName(rule);
  const num = (kind, v) => withUnit(displayNumber(kind, v, units), unitLabel(kind, units));
  const rain = (v) => `${displayNumber("precip", v, units)} ${unitLabel("precip", units)}/h`;
  switch (fail.kind) {
    case "no-data":
      return `No data for ${name}`;
    case "above":
    case "below": {
      const kind = METRICS[rule.metric]?.kind;
      if (!kind) return `${name}: ${fail.kind}`;
      return `${name} ${num(kind, fail.value)} ${fail.kind === "above" ? ">" : "<"} ${num(kind, fail.limit)}`;
    }
    case "margin":
      return `${name} ${num("tempDelta", fail.value)} < ${num("tempDelta", fail.limit)}`;
    case "wet":
      return fail.detail === "prob"
        ? `Rain chance in dry window: ${fail.value}% > ${fail.limit}%`
        : `Rain in dry window: ${rain(fail.value)} > ${rain(fail.limit)}`;
    case "dark":
      return "Not daylight";
    default:
      return `${name}: ${fail.kind}`;
  }
}
