// Starter rule sets from spec §15. All numbers are unsourced starting points, not guidance;
// each preset's `notes` says so, and the UI tells users the product datasheet overrides them.
const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

export const PRESETS = deepFreeze([
  {
    id: "paint-exterior",
    name: "Exterior paint",
    notes:
      "Unsourced starter defaults. Published guidance disagrees: dew-point margins of about 5 to 6 °F " +
      "(roughly 3 °C) are common, and humidity advice ranges from a 40 to 70% sweet spot up to an 85% " +
      "ceiling. Wind 25 km/h and the 0.1 mm/h rain threshold are unsourced. Your product's datasheet overrides all of these.",
    ruleSet: {
      v: 1,
      minHours: 6,
      horizonDays: 7,
      rules: [
        { id: "temp", type: "range", metric: "temp", min: 10, max: 29 },
        { id: "dew", type: "dewMargin", min: 3 },
        { id: "rh", type: "range", metric: "rh", max: 85 },
        { id: "wind", type: "range", metric: "wind", max: 25 },
        { id: "dry", type: "dry", before: 4, after: 8, maxMm: 0.1, maxProb: null },
        { id: "day", type: "daylight" },
      ],
    },
  },
  {
    id: "laundry",
    name: "Hang laundry outside",
    notes: "Unsourced starter defaults: all thresholds are guesses. Edit them to match your climate and fabrics.",
    ruleSet: {
      v: 1,
      minHours: 4,
      horizonDays: 7,
      rules: [
        { id: "temp", type: "range", metric: "temp", min: 12 },
        { id: "rh", type: "range", metric: "rh", max: 70 },
        { id: "dry", type: "dry", before: 0, after: 4, maxMm: 0.1, maxProb: null },
        { id: "day", type: "daylight" },
      ],
    },
  },
  {
    id: "bike-commute",
    name: "Bike commute",
    notes: "Unsourced starter defaults: all thresholds are guesses. Set the window length to your ride time.",
    ruleSet: {
      v: 1,
      minHours: 1,
      horizonDays: 7,
      rules: [
        { id: "apparent", type: "range", metric: "apparent", min: 2, max: 32 },
        { id: "gust", type: "range", metric: "gust", max: 35 },
        { id: "dry", type: "dry", before: 0, after: 1, maxMm: 0.1, maxProb: 30 },
      ],
    },
  },
]);

export const DEFAULT_PRESET_ID = "paint-exterior";

// Independent, mutable copy of a preset's rule set (PRESETS itself is frozen). null for an unknown id.
export function clonePreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  return p ? structuredClone(p.ruleSet) : null;
}
