const START_T = Date.UTC(2026, 8, 19) / 1000;

// index i -> hour of day, given START_T is 2026-09-19T00:00:00Z
function defaultsFor(i) {
  const hourOfDay = i % 24;
  return {
    temp: 20,
    apparent: 20,
    dewPoint: 12,
    rh: 55,
    precip: 0,
    precipProb: 0,
    wind: 10,
    gust: 15,
    uv: 3,
    cloud: 30,
    isDay: hourOfDay >= 6 && hourOfDay <= 19 ? 1 : 0,
    missing: false,
  };
}

// overrides: either a flat object applied to every hour, or a map of
// { [index]: partialOverrides } applied per hour. Both may be combined
// by passing { all: {...}, byIndex: { [i]: {...} } }.
export function makeHours(count, overrides = {}) {
  const { all = {}, byIndex = {} } = overrides;
  const hours = [];
  for (let i = 0; i < count; i++) {
    hours.push({
      t: START_T + i * 3600,
      ...defaultsFor(i),
      ...all,
      ...(byIndex[i] || {}),
    });
  }
  return hours;
}

export { START_T };
