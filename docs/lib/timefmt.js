// Epoch + IANA tz -> local calendar fields. Uses Intl only; no Date.now().
const partsFormatters = new Map();

function partsFormatter(tz) {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

const pad = (n, w) => String(n).padStart(w, "0");

export function localParts(epochSec, tz) {
  const p = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(new Date(epochSec * 1000))) {
    if (type !== "literal") p[type] = Number(value);
  }
  const { year, month, day } = p;
  return {
    dateKey: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
    year,
    month,
    day,
    hour: p.hour,
    minute: p.minute,
    // Sunday = 0. Derived from the calendar date, so it is independent of tz.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

// Groups hours into local calendar days. Each cell keeps its index into `hours`.
// On a fall-back day the repeated local hour appears twice; the second is `ambiguous`.
export function groupByLocalDay(hours, tz) {
  const days = [];
  let day = null;
  let prev = null;
  hours.forEach((h, i) => {
    const p = localParts(h.t, tz);
    if (!day || day.dateKey !== p.dateKey) {
      day = { dateKey: p.dateKey, year: p.year, month: p.month, day: p.day, weekday: p.weekday, cells: [] };
      days.push(day);
      prev = null;
    }
    const ambiguous = prev !== null && prev.hour === p.hour && prev.minute === p.minute;
    day.cells.push({ i, t: h.t, hour: p.hour, minute: p.minute, ambiguous });
    prev = p;
  });
  return days;
}

export function hourLabel(t, tz, locale, { ambiguous = false } = {}) {
  const opts = { timeZone: tz, hour: "numeric" };
  if (ambiguous) opts.timeZoneName = "short";
  return new Intl.DateTimeFormat(locale, opts).format(new Date(t * 1000));
}
