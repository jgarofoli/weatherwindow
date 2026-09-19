const EPS = 1e-9;

function isNil(v) {
  return v === null || v === undefined;
}

function evalRange(rule, hour) {
  const value = hour[rule.metric];
  if (isNil(value)) {
    return { ruleId: rule.id, kind: "no-data", value: null, limit: null };
  }
  if (rule.min !== undefined && value < rule.min - EPS) {
    return { ruleId: rule.id, kind: "below", value, limit: rule.min };
  }
  if (rule.max !== undefined && value > rule.max + EPS) {
    return { ruleId: rule.id, kind: "above", value, limit: rule.max };
  }
  return null;
}

function evalDewMargin(rule, hour) {
  const { temp, dewPoint } = hour;
  if (isNil(temp) || isNil(dewPoint)) {
    return { ruleId: rule.id, kind: "no-data", value: null, limit: rule.min };
  }
  const margin = temp - dewPoint;
  if (margin < rule.min - EPS) {
    return { ruleId: rule.id, kind: "margin", value: margin, limit: rule.min };
  }
  return null;
}

function evalDry(rule, hours, i) {
  const before = rule.before ?? 0;
  const after = rule.after ?? 0;
  const { maxMm, maxProb } = rule;
  const lo = i - before;
  const hi = i + after;

  for (let h = lo; h <= hi; h++) {
    if (h < 0 || h >= hours.length || hours[h].missing || isNil(hours[h].precip)) {
      return { ruleId: rule.id, kind: "no-data", value: null, limit: maxMm };
    }
  }
  for (let h = lo; h <= hi; h++) {
    if (hours[h].precip > maxMm + EPS) {
      return { ruleId: rule.id, kind: "wet", value: hours[h].precip, limit: maxMm };
    }
  }
  if (!isNil(maxProb)) {
    for (let h = lo; h <= hi; h++) {
      if (isNil(hours[h].precipProb)) {
        return { ruleId: rule.id, kind: "no-data", value: null, limit: maxProb, detail: "prob" };
      }
    }
    for (let h = lo; h <= hi; h++) {
      if (hours[h].precipProb > maxProb + EPS) {
        return { ruleId: rule.id, kind: "wet", value: hours[h].precipProb, limit: maxProb, detail: "prob" };
      }
    }
  }
  return null;
}

function evalDaylight(rule, hour) {
  if (isNil(hour.isDay)) {
    return { ruleId: rule.id, kind: "no-data", value: null, limit: null };
  }
  if (hour.isDay !== 1) {
    return { ruleId: rule.id, kind: "dark", value: hour.isDay, limit: 1 };
  }
  return null;
}

function evalRule(rule, hours, i) {
  const hour = hours[i];
  switch (rule.type) {
    case "range":
      return evalRange(rule, hour);
    case "dewMargin":
      return evalDewMargin(rule, hour);
    case "dry":
      return evalDry(rule, hours, i);
    case "daylight":
      return evalDaylight(rule, hour);
    default:
      throw new TypeError(`Unknown rule type: ${rule.type}`);
  }
}

export function evaluateHours(hours, rules) {
  return hours.map((hour, i) => {
    const fails = [];
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      const fail = evalRule(rule, hours, i);
      if (fail) fails.push(fail);
    }
    return { i, t: hour.t, pass: fails.length === 0, fails };
  });
}

export function isPastHour(evalHour, nowT) {
  return !isNil(nowT) && evalHour.t + 3600 <= nowT;
}

export function findWindows(evals, { minHours, nowT } = {}) {
  const windows = [];
  let start = null;
  let end = null;
  let prevT = null;

  const flush = () => {
    if (start !== null && end - start + 1 >= minHours) {
      windows.push({
        startIdx: start,
        endIdx: end,
        hours: end - start + 1,
        startT: evals[start].t,
        endT: evals[end].t,
      });
    }
    start = null;
    end = null;
  };

  for (let idx = 0; idx < evals.length; idx++) {
    const e = evals[idx];
    const eligible = e.pass && !isPastHour(e, nowT);
    if (!eligible) {
      flush();
      prevT = null;
      continue;
    }
    const contiguous = prevT === null || e.t - prevT === 3600;
    if (!contiguous) {
      flush();
      start = idx;
    } else if (start === null) {
      start = idx;
    }
    end = idx;
    prevT = e.t;
  }
  flush();
  return windows;
}

export function pickBest(windows) {
  if (windows.length === 0) return null;
  return windows.reduce((best, w) => {
    if (w.hours > best.hours) return w;
    if (w.hours === best.hours && w.startIdx < best.startIdx) return w;
    return best;
  });
}

export function findNearMisses(evals, { minHours, nowT } = {}) {
  const nearMisses = [];
  let start = null;
  let end = null;
  let prevT = null;
  let blocker = null;
  let failCount = 0;

  function containsWindow(s, e) {
    let run = 0;
    for (let idx = s; idx <= e; idx++) {
      if (evals[idx].pass) {
        run++;
        if (run >= minHours) return true;
      } else {
        run = 0;
      }
    }
    return false;
  }

  const flush = () => {
    if (start !== null) {
      const length = end - start + 1;
      if (length >= minHours && failCount >= 1 && !containsWindow(start, end)) {
        nearMisses.push({
          startIdx: start,
          endIdx: end,
          hours: length,
          blockingRuleId: blocker,
          failCount,
        });
      }
    }
    start = null;
    end = null;
    blocker = null;
    failCount = 0;
  };

  for (let idx = 0; idx < evals.length; idx++) {
    const e = evals[idx];
    const hardBreak = isPastHour(e, nowT) || e.fails.length > 1;

    if (hardBreak) {
      flush();
      prevT = null;
      continue;
    }

    const contiguous = prevT === null || e.t - prevT === 3600;
    if (!contiguous) {
      flush();
      start = idx;
    }

    if (e.fails.length === 1) {
      const ruleId = e.fails[0].ruleId;
      if (blocker !== null && ruleId !== blocker) {
        flush();
        start = idx;
      }
      if (start === null) start = idx;
      blocker = ruleId;
      failCount++;
    } else if (start === null) {
      start = idx;
    }

    end = idx;
    prevT = e.t;
  }
  flush();
  return nearMisses;
}
