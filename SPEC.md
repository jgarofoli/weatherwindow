# Weather Window Finder: Spec

## 1. Purpose and non-goals

Find windows in the hourly forecast where ALL of the user's rules hold for a minimum number of consecutive hours (example: "exterior paint": air temp 10 to 29 °C, at least 3 °C above dew point, no rain for 4 h before and 8 h after, daylight, at least 6 h long).

Answer first (best window sentence + day/hour grid), rules second (editable sentences), "why not" third (which rules failed for an hour, and closest misses).

Non-goals (v1): notifications, accounts, multi-location compare, ensemble or multi-model spread, surface-temperature estimates, server code, analytics, ads.

## 2. Constraints

- Static site on GitHub Pages, served from `docs/` on the main branch. Entry point: `docs/index.html`.
- No build step, no bundler, no framework, no runtime dependencies. Native ES modules.
- Tests: Node built-in runner (`node:test`, `node:assert/strict`), Node 20+. No devDependencies. Local only, no CI, no hooks required.
- No cookies. No third-party requests except Open-Meteo (`api.open-meteo.com`, `geocoding-api.open-meteo.com`).
- Open-Meteo free-tier terms: non-commercial only (no ads, no subscriptions), under 10,000 calls/day, 5,000/hour, 600/minute, attribution link "Weather data by Open-Meteo.com" shown next to any location.
- Project Pages serve under `/<repo>/`. Use RELATIVE paths everywhere (`./lib/engine.js`), never `/lib/...`.
- ES modules do not load from `file://`. Local dev needs a static server.

## 3. Repo layout and local workflow

```
/
├─ docs/
│  ├─ index.html          markup only
│  ├─ style.css           all CSS (no inline style, so CSP needs no unsafe-inline)
│  ├─ app.js              DOM glue only; no logic worth testing
│  ├─ .nojekyll
│  └─ lib/
│     ├─ engine.js        PURE: evaluate hours, find windows, near-misses, pick best
│     ├─ rules.js         rule schema, validate, describe (sentences)
│     ├─ presets.js       starter rule sets
│     ├─ units.js         metric/imperial conversions (display only)
│     ├─ timefmt.js       epoch + IANA tz -> local parts, day grouping, labels
│     ├─ forecast.js      buildForecastUrl, parseForecast
│     ├─ geo.js           buildGeocodeUrl, normalizeGeocode, roundCoord
│     ├─ api.js           fetchJson with injected fetch, typed errors
│     ├─ urlstate.js      encode/decode location + rules to URL hash
│     └─ viewmodel.js     PURE: engine output -> render-ready structure + sentences
├─ tests/
│  ├─ *.test.js
│  ├─ support/            makeHours.js, deepFreeze.js (NOT named test*, not run as tests)
│  ├─ fixtures/           real captured API JSON
│  └─ golden/             engine outputs on real fixtures
├─ scripts/capture-fixture.mjs
├─ package.json
└─ README.md
```

package.json scripts:

```json
{
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test tests/*.test.js",
    "test:watch": "node --test --watch tests/*.test.js",
    "serve": "python3 -m http.server 8000 --directory docs",
    "capture": "node scripts/capture-fixture.mjs",
    "golden:update": "UPDATE_GOLDEN=1 node --test tests/golden.test.js"
  }
}
```

Deploy: repo Settings > Pages > Deploy from branch > main > /docs. Manual push. Run `npm test` before pushing.

## 4. Architecture

Pure core, thin shell. Everything with logic is a pure function of its inputs (no `Date.now()`, no `fetch`, no DOM inside `lib/` except where injected). `app.js` wires DOM events to `lib/`.

Data flow: location -> `buildForecastUrl` -> `fetchJson` -> `parseForecast` -> `hours[]` -> `evaluateHours(hours, rules)` -> `findWindows` / `findNearMisses` / `pickBest` -> `buildViewModel` -> render.

Editing rules re-runs everything after `fetchJson` locally. It never refetches. Only a location or horizon change fetches.

## 5. Data model

Canonical units internally and in the URL: °C, km/h, mm, %. Imperial is display-only.

Hour record (`parseForecast` output, `engine` input):

```js
{ t: 1789000000,      // epoch seconds UTC (request timeformat=unixtime)
  temp, apparent, dewPoint, rh, precip, precipProb, wind, gust, uv, cloud, // numbers or null
  isDay,              // 1 | 0 | null
  missing: false }    // true for gap-filled hours (all metrics null)
```

Forecast request:
`hourly=temperature_2m,apparent_temperature,dew_point_2m,relative_humidity_2m,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,uv_index,cloud_cover,is_day`
`&timeformat=unixtime&timezone=auto&forecast_days=7&past_days=1&wind_speed_unit=kmh&temperature_unit=celsius&precipitation_unit=mm`

`past_days=1` supplies lookback hours for "dry before" rules. Response `timezone` (IANA name) is used for display only.

Hours are indexed by array position. Consecutive means `t[i] - t[i-1] === 3600`. Any other gap breaks windows.

## 6. Rules and evaluation semantics

Rule-set JSON (this is also what goes in the URL):

```json
{
  "v": 1, "minHours": 6, "horizonDays": 7,
  "rules": [
    { "id": "temp", "type": "range", "metric": "temp", "min": 10, "max": 29 },
    { "id": "dew",  "type": "dewMargin", "min": 3 },
    { "id": "rh",   "type": "range", "metric": "rh", "max": 85 },
    { "id": "wind", "type": "range", "metric": "wind", "max": 25 },
    { "id": "dry",  "type": "dry", "before": 4, "after": 8, "maxMm": 0.1, "maxProb": null },
    { "id": "day",  "type": "daylight" }
  ]
}
```

Rule types (four, all ANDed, any rule may carry `"enabled": false`):

- `range`: metric in {temp, apparent, rh, wind, gust, precipProb, uv, cloud}; optional `min`, optional `max`; both inclusive; at least one required; `min <= max`.
- `dewMargin`: `temp - dewPoint >= min`.
- `dry`: at hour `h`, every hour in `[h - before, h + after]` (inclusive, includes `h`) must have `precip <= maxMm`, and if `maxProb` is set, `precipProb <= maxProb`. `before` and `after` are integers 0 to 24. Because the check is per hour, a run of passing hours is dry throughout, plus `before` hours ahead of it and `after` hours behind it.
- `daylight`: `isDay === 1`.

Missing data policy (conservative): a rule that needs a null metric FAILS with `kind: "no-data"`. For `dry`, any hour in the range that is outside the array, `missing`, or has null `precip` fails with `no-data`. If `maxProb` is set, null `precipProb` in range is `no-data`.

Comparisons use epsilon 1e-9 (naive `0.3 - 0.1 >= 0.2` is false in JS).

Fail record: `{ ruleId, kind: "below"|"above"|"margin"|"wet"|"dark"|"no-data", value, limit, detail? }`. An hour's `fails` lists every failing enabled rule in rule order. `pass = fails.length === 0`.

Engine API:

```js
evaluateHours(hours, rules)                  // -> [{ i, t, pass, fails }]
findWindows(evals, { minHours, nowT })       // -> [{ startIdx, endIdx, hours, startT, endT }]  (endT = last hour's t)
pickBest(windows)                            // longest; ties -> earliest; null if none
findNearMisses(evals, { minHours, nowT })    // -> [{ startIdx, endIdx, hours, blockingRuleId, failCount }]
```

`nowT`: hours whose `t + 3600 <= nowT` are past; they are evaluated (for lookback) but never appear in windows or near-misses. The current hour is included.

Near-miss: maximal run of consecutive hours where every hour has at most 1 failing rule, all failing hours share the same rule id (the blocker), length >= `minHours`, at least one failing hour, and the run contains no real window (no sub-run of passing hours >= `minHours`). When a different blocker appears, close the run and start a new one at that hour.

## 7. Other module contracts

- `units.js`: `cToF, fToC, kmhToMph, mphToKmh, mmToIn, inToMm`; round-trip within 1e-9. Thresholds are stored canonical and never rounded; displayed values are rounded.
- `rules.js`: `validateRuleSet(obj)` returns `{ ok, errors, value }` (clamps `before`/`after` to 0..24, caps rules at 20, rejects unknown types/metrics, min > max). `describeRule(rule, units)` returns a sentence ("Air temperature between 10 and 29 °C").
- `timefmt.js`: `localParts(epochSec, tz)` -> `{ dateKey, year, month, day, hour, minute, weekday }` (use `hourCycle: "h23"`); `groupByLocalDay(hours, tz)`; `hourLabel(t, tz, locale, { ambiguous })`. The repeated hour on a fall-back day is flagged `ambiguous` and labeled with the tz abbreviation.
- `forecast.js`: `parseForecast(json)` -> `{ tz, utcOffsetSeconds, hours }`. Throws `ParseError` naming the problem for: missing variable, unequal array lengths, unexpected `hourly_units` (temp not °C, wind not km/h, precip not mm). Fills gaps in `time` with `missing` hours. Preserves nulls.
- `geo.js`: `buildGeocodeUrl(q, { count = 8, language = "en" })` returns `null` if `q.trim().length < 3`. `normalizeGeocode(json)` returns `[]` when `results` is absent, else `[{ id, name, admin1, country, countryCode, lat, lon, tz, label }]`. `roundCoord(x, 2)`.
- `api.js`: `fetchJson(url, { timeoutMs = 10000, fetchImpl = fetch })`. Throws `ApiError` with `kind`: `"rate-limit"` (HTTP 429), `"server"` (5xx), `"timeout"`, `"network"`, `"bad-response"` (invalid JSON), `"api-error"` (payload flags an error; carry `reason`).
- `urlstate.js`: `encodeState({ loc: { name, lat, lon }, units, ruleSet })` -> hash string; `decodeState(hash)` -> `{ state, warnings }`. Hash form: `#v=1&lat=..&lon=..&n=..&u=metric&r=<base64url(JSON)>`. Coordinates rounded to 2 decimals. Name capped at 80 chars, control characters stripped. Invalid or unknown-version input falls back to defaults with a warning. Never throws.
- `viewmodel.js`: `buildViewModel({ hours, evals, windows, nearMisses, tz, locale, nowT, units })` -> `{ bestSentence, days: [{ dateKey, label, cells: [{ i, t, state: "pass"|"near"|"fail"|"past", label, ambiguous, fails }] }], windows: [...], nearMisses: [...] }`. `state: "near"` = exactly one failing rule.

## 8. UI

Mobile-first (360 px), light/dark via `prefers-color-scheme`, one column.

1. **Location card**: search input (min 3 chars, 300 ms debounce, results list shows name, region, country), "Use my location" button (geolocation only on click), lat/lon manual fallback under "advanced". "Weather data by Open-Meteo.com" link sits here.
2. **Preset picker + rule list**: each rule is a sentence with inline numeric inputs, an enabled checkbox and a remove button. "Add rule" offers the fixed templates. Controls for minimum window hours (1 to 24), horizon (3 / 7 / 14 days), units toggle. "Save rules" (localStorage), "Copy link".
3. **Result**: best-window sentence; heat grid (rows = local days, columns = hours); window list; "Closest misses" list. If no window, show up to 3 near-misses.
4. **Hour detail**: tapping a grid cell shows every failing rule with value vs limit ("Wind 31 km/h > 25").
5. **Footer**: disclaimer ("Decision aid, not a guarantee. Forecast skill drops with lead time. Presets are starting points; check your product's datasheet.").

Accessibility: grid cells are `<button>`s with `aria-label` ("Fri 3 PM: fails wind, 31 km/h over 25"). State is conveyed by glyph (check / tilde / cross) as well as color. The window list is the primary output, so the grid is optional for screen readers. Known risk: 24 columns at 360 px gives small tap targets. Mitigation: tapping a day label opens that day's hour list.

Security: all API/user-derived text is set with `textContent`. No `innerHTML` with external data. CSP meta tag: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://api.open-meteo.com https://geocoding-api.open-meteo.com; base-uri 'none'`.

## 9. State, storage, privacy

- Source of truth for sharing: URL hash. Updated on every state change with `history.replaceState`. Hash is never sent to the server.
- localStorage key `wwf:v1:saved`, written only on explicit "Save rules" (max 20 entries, guarded parse). JSON export/import as backup; treat storage as a cache, not a database.
- No cookies, no analytics. Shared links contain coordinates rounded to about 1 km.

## 10. Errors (user-visible messages)

- `rate-limit`: "The weather service is busy. Try again in a few minutes." Keep last good result on screen.
- `network` / `timeout` / `server`: one retry button.
- `bad-response` / `api-error` / `ParseError`: generic message plus details in the console.
- Geolocation denied: message and fall back to search.
- Bad hash: load defaults, banner "Couldn't read the shared link."

## 11. TDD progression (de-risk order)

Rule: write the tests for a milestone first and see them fail, then implement, then refactor. Do not start milestone N+1 until milestone N's exit criteria pass. Time budget (5 h): M0 0.25, M1 1.0, M2 0.75, M3 0.5, M4 0.5, M5 1.0, M6 0.75, M7 0.25.

**M0: Harness (0.25 h).** `package.json`, one trivial passing test, `npm run serve` serves a blank `docs/index.html`, `docs/.nojekyll`. Exit: `npm test` is green; the page loads at `http://localhost:8000`.

**M1: Engine on a hard-coded response (1.0 h). The core de-risk.** No network, no UI, no parser. Only `engine.js`, `tests/support/makeHours.js` and `tests/engine.test.js`. `makeHours(overrides)` builds hours from a fixed start (`Date.UTC(2026,8,19)/1000`) with defaults: temp 20, dewPoint 12, rh 55, wind 10, gust 15, precip 0, precipProb 0, uv 3, cloud 30, `isDay` 1 for hour indexes 6 to 19 else 0.

Canonical scenario S1 (24 hours, index 0 to 23), rules: temp 10 to 29, dewMargin 3, wind max 25, dry before 2 / after 3 / maxMm 0.1, daylight. Override: precip 1.0 at index 15. Hand-derived expectations (write the arithmetic in the test comments):

- Dry fails at h where 15 is in [h-2, h+3], so h = 12..17.
- Dry is `no-data` at h = 0, 1 (lookback out of range) and h = 21, 22, 23 (lookahead out of range).
- Daylight passes 6..19 only.
- Passing hours: 6..11 and 18..19.
- `minHours = 6` gives one window {startIdx 6, endIdx 11, hours 6}; `minHours = 2` gives two windows.
- `pickBest` returns 6..11.
- Hours 21..23 and 0..1 have two fails each (dark + no-data).

Exit criteria: all engine tests below pass, and you can explain every rule's behavior from the three rule types (range, dewMargin, dry) plus daylight and min hours, without hand-waving. If you can't, stop and redesign the rule semantics before writing any UI.

**M2: Real response, parser, time and DST (0.75 h).** Run `npm run capture` to save real forecast and geocoding responses to `tests/fixtures/` (see section 14 checklist). Write `forecast.js`, `timefmt.js`, `units.js` against them. Exit: parser tests pass on real fixtures; DST tests pass; the section 14 assumptions are confirmed or the spec is amended. Kill/pivot check: if `precipitation_probability` or `dew_point_2m` are null for typical locations, decide whether to drop `maxProb` or require dew data before going further.

**M3: Rules, serialization, presets (0.5 h).** `rules.js`, `urlstate.js`, `presets.js`. Exit: every preset validates and evaluates without throwing on the real fixture; round-trip encode/decode passes.

**M4: Near-misses, ranking, view-model (0.5 h).** `findNearMisses`, `viewmodel.js`. Exit: S1 near-miss expectation below passes; sentences are deterministic.

**M5: UI on fixtures, no network (1.0 h).** `index.html`, `style.css`, `app.js`. A dev-only query flag `?fixture=name` loads a fixture from `tests/fixtures/` copy in `docs/dev/` (delete before release or leave, harmless). Build the whole UI and rule editing against that. Exit: manual QA checklist (section 13) items 1 to 6 pass on a phone-width window.

**M6: Live data (0.75 h).** `geo.js`, `api.js` wired to the UI, geolocation button, error states. Exit: injected-fetch tests for every `ApiError` kind pass; manual QA items 7 to 10 pass locally.

**M7: Ship (0.25 h).** README, push, Pages on. Post-deploy smoke test on the real `github.io` origin (CORS can't be tested from localhost): item 11 to 12 of the checklist.

## 12. Test inventory (write these first)

`engine.test.js`
- all hours pass -> one window covering all
- one failing hour splits the run; `minHours` filters short runs
- range boundaries inclusive: temp == min passes, min - 0.1 fails `below`; max likewise `above`
- epsilon: `temp 0.3, dew 0.1, dewMargin min 0.2` passes
- null metric under a rule -> fails `no-data`, no throw
- dewMargin: temp 12 / dew 10 / min 3 fails with value 2; exactly 3 passes
- dry: rain at index 10, before 2, after 3 -> hours 7..12 fail `wet`
- dry edges: index 0 with before 2 and last index with after 3 -> `no-data`
- dry with `maxProb`: prob 41 with `maxProb` 40 fails `wet` (detail "prob")
- daylight: `isDay` 0 fails `dark`; null `isDay` fails `no-data`
- multiple fails on one hour: all listed, in rule order
- `enabled: false` rule ignored
- non-contiguous `t` (gap != 3600) breaks a window even if indexes are adjacent
- `nowT`: past hours are excluded from windows; the current hour is included
- `pickBest`: longest wins; tie goes to earliest; empty -> null
- purity: inputs deep-frozen, no mutation, same output on repeat call
- unknown rule type -> throws `TypeError`

Near-miss (M4), on S1 with `minHours = 6`: exactly one near-miss, indexes 12..19, `blockingRuleId "dry"`, `failCount 6`. (The run 2..11 blocked by daylight is excluded because it contains a real window 6..11.) Also: hours failing two different rules are never near-misses; pattern [pass, pass, wind-fail, pass, temp-fail, pass] with `minHours 3` yields run 0..3 blocked by wind and drops the length-2 tail.

`forecast.test.js`: length and first `t` on real fixture; nulls preserved; missing variable throws `ParseError` naming it; unequal array lengths throw; `hourly_units` mismatch throws; a synthetic gap in `time` yields `missing` hours.

`timefmt.test.js` (America/New_York; assert structured fields, not formatted strings, since ICU may insert a narrow no-break space before AM/PM):
- 2026-03-08 spring forward: instants 05:00Z, 06:00Z, 07:00Z give local hours 0, 1, 3; the local day has 23 cells.
- 2026-11-01 fall back: instants 04:00Z, 05:00Z, 06:00Z, 07:00Z give local hours 0, 1, 1, 2; the day has 25 cells; the second "1" is `ambiguous`.
- formatted labels only smoke-tested with `/\d{1,2}(:\d{2})?/`.

`rules.test.js`: valid set passes; min > max rejected; unknown metric/type rejected; `before` 99 clamped to 24; more than 20 rules rejected; `describeRule` metric vs imperial strings; 50 °F entered in imperial stores 10 °C and displays back as 50.

`urlstate.test.js`: round trip; unknown version -> defaults + warning; tampered base64 -> defaults, no throw; name with `<script>` and control chars stays inert data (sanitized to length/control-free; rendering safety is enforced by `textContent`); hash length under 2000 chars for a 10-rule set; coordinates rounded to 2 decimals.

`geo.test.js`: `q` under 3 chars -> `null`; missing `results` -> `[]`; label "Springfield, Illinois, United States"; two same-name results keep distinct ids.

`api.test.js` (fake `fetchImpl`): 429 -> `rate-limit`; 500 -> `server`; abort -> `timeout`; rejection -> `network`; non-JSON -> `bad-response`; error payload -> `api-error` with `reason`.

`presets.test.js`: every preset passes `validateRuleSet`; every preset evaluates on the real fixture without throwing; each has a non-empty `notes` string.

`viewmodel.test.js`: best-window sentence for a known window ("Best window", weekday, start/end hours, "6 h"); no-window case names the closest near-miss; `past` cells marked; cell counts per day match `timefmt` (23/25 on DST days).

`golden.test.js`: engine output for each preset on the real fixture equals `tests/golden/*.json`. Regenerate only with `npm run golden:update` and review the diff by eye.

## 13. Manual QA checklist

Local (`npm run serve`, DevTools device mode 360 px):
1. Default preset renders a plausible best window for a searched city.
2. Editing a number re-evaluates instantly and makes no network request (Network tab).
3. Tapping a red cell shows the failing rule with value vs limit.
4. Imperial toggle changes displayed numbers and not the shared-link rules.
5. Copy link, open in a fresh tab: same location, rules and result.
6. Remove all rules: sane message (everything passes, minimum length applies).
7. Search "Springfield": disambiguation list shows region and country.
8. Deny geolocation: falls back to search with a message.
9. DevTools offline: network error message and retry button; last result stays.
10. Block `api.open-meteo.com` response with 429 (DevTools override or fake): friendly message.

Post-deploy (github.io origin):
11. Forecast and geocoding calls succeed (CORS), no CSP errors in console.
12. Attribution link is visible next to the location; no cookies in Application tab.

## 14. Assumptions to confirm at M2 (real capture)

Already confirmed in Open-Meteo docs: hourly variables `dew_point_2m`, `precipitation_probability`, `wind_gusts_10m`, `is_day`, `uv_index`, `cloud_cover` exist; `timeformat=unixtime` is supported; forecasts reach up to 16 days depending on model.

To confirm from captured fixtures:
- `past_days=1` returns 24 extra past hours at the start of `hourly`.
- `timezone=auto` populates response `timezone` and `utc_offset_seconds`; `hourly_units` present with expected strings.
- Whether `precipitation_probability` is null in some regions/models.
- Geocoding response has no `results` key when nothing matches (else adjust `normalizeGeocode`).
- Error payload shape for a bad request (status code and `reason` field).
- Forecast `time` array is strictly hourly (or where gaps occur).
- Limits behavior under 429 (headers, body).

## 15. Preset starter defaults (unsourced until reviewed)

Every preset carries `notes` stating where its numbers came from or "unsourced starter default". Source disagreement is expected: published guidance for exterior paint differs (dew-point margin of about 5 to 6 °F, humidity guidance from a 40 to 70% sweet spot to an 85% ceiling), so thresholds are editable, and the UI states that the product datasheet overrides them.

- `paint-exterior`: temp 10 to 29 °C, dewMargin 3 °C, rh max 85, wind max 25 (unsourced), dry before 4 / after 8, daylight, minHours 6.
- `laundry`: temp min 12, rh max 70, dry after 4, daylight, minHours 4 (all unsourced).
- `bike-commute`: apparent 2 to 32 °C, gust max 35, dry with maxProb 30 and after 1, minHours 1 (all unsourced).

## 16. Definition of done

- `npm test` green; every test in section 12 exists and passes.
- Section 13 checklist passes locally and post-deploy.
- Zero runtime dependencies; zero cookies; only Open-Meteo network calls.
- Attribution link visible; disclaimer visible.
- README documents commands, deploy steps and the section 14 findings.

## 17. Deferred (v2 candidates)

Ensemble/multi-model agreement, surface-temperature estimate for paint, saved-rule sharing gallery, notifications (needs a backend), multi-location compare, locale-aware default units.

---

Bonus (from the original request): add stargazing, including sunset/sunrise, moonset/moonrise and moon phase (for dark skies). Also: does Open-Meteo do coastal wave forecasts, for surfers or wave watchers? (See PLAN.md "Bonus ideas" for findings.)
