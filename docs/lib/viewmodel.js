// PURE: engine output -> render-ready structure. No DOM, no Date.now(); `nowT` and `tz` come in.
import { isPastHour, pickBest } from "./engine.js";
import { dayLabel, groupByLocalDay, hourLabel, localParts } from "./timefmt.js";
import { describeFail, ruleName } from "./rules.js";

// Closest first: fewest failing hours to fix, then longest run, then earliest.
const byCloseness = (a, b) => a.failCount - b.failCount || b.hours - a.hours || a.startIdx - b.startIdx;

export function buildViewModel({ hours, evals, windows, nearMisses, tz, locale, nowT, units = "metric", rules = [] }) {
  if (hours.length !== evals.length) {
    throw new RangeError(`hours (${hours.length}) and evals (${evals.length}) must be the same length`);
  }
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  // Cells, by day, in index order.
  const labelAt = new Map();
  const days = groupByLocalDay(hours, tz).map((day) => ({
    dateKey: day.dateKey,
    label: dayLabel(day, locale),
    cells: day.cells.map((c) => {
      const ev = evals[c.i];
      const label = hourLabel(c.t, tz, locale, { ambiguous: c.ambiguous });
      labelAt.set(c.i, label);
      let state;
      if (isPastHour(ev, nowT)) state = "past";
      else if (ev.pass) state = "pass";
      else if (ev.fails.length === 1) state = "near";
      else state = "fail";
      return {
        i: c.i,
        t: c.t,
        state,
        label,
        ambiguous: c.ambiguous,
        fails: ev.fails.map((f) => ({ ...f, text: describeFail(f, ruleById.get(f.ruleId), units) })),
      };
    }),
  }));

  // "Sat 9 AM to 3 PM": a run of hours startIdx..endIdx ends at the *end* of its last hour.
  function rangeText(startIdx, endIdx) {
    const startT = hours[startIdx].t;
    const endT = hours[endIdx].t + 3600;
    const next = hours[endIdx + 1];
    const endLabel = next && next.t === endT ? labelAt.get(endIdx + 1) : hourLabel(endT, tz, locale);
    const s = localParts(startT, tz);
    const e = localParts(endT, tz);
    const weekday = (p) => dayLabel(p, locale, { weekday: "short" });
    const end = s.dateKey === e.dateKey ? endLabel : `${weekday(e)} ${endLabel}`;
    return `${weekday(s)} ${labelAt.get(startIdx)} to ${end}`;
  }

  const best = pickBest(windows);
  const windowVms = windows.map((w) => ({
    ...w,
    isBest: best !== null && w.startIdx === best.startIdx,
    sentence: `${rangeText(w.startIdx, w.endIdx)} (${w.hours} h)`,
  }));

  const nearMissVms = [...nearMisses].sort(byCloseness).map((nm) => {
    const rule = ruleById.get(nm.blockingRuleId);
    const name = rule ? ruleName(rule) : nm.blockingRuleId;
    const extent = nm.failCount === nm.hours ? `all ${nm.hours} h` : `${nm.failCount} of ${nm.hours} h`;
    return { ...nm, sentence: `${rangeText(nm.startIdx, nm.endIdx)}: only ${name} holds it back, for ${extent}` };
  });

  let bestSentence;
  if (hours.length === 0) bestSentence = "No forecast data.";
  else if (best) bestSentence = `Best window: ${windowVms.find((w) => w.isBest).sentence}`;
  else if (nearMissVms.length) bestSentence = `No window found. Closest miss: ${nearMissVms[0].sentence}.`;
  else bestSentence = "No window found in this forecast.";

  return { bestSentence, days, windows: windowVms, nearMisses: nearMissVms };
}
