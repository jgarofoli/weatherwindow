# Weather Window Finder — Plan

Static, no-build, no-dependency site on GitHub Pages (`docs/`) that finds
windows in an hourly forecast where all of a user's rules hold for a
minimum consecutive-hour run. Full spec is in [`SPEC.md`](SPEC.md) (verbatim from the original
request; section numbers referenced below, e.g. §11, §14, refer to it); this file tracks milestone status and decisions made
along the way so work can resume without re-deriving context.

## Architecture recap

Pure core, thin shell: `docs/lib/*.js` holds all logic as pure functions
(no `Date.now()`, no `fetch`, no DOM), `docs/app.js` wires DOM to `lib/`.

Data flow: location -> `buildForecastUrl` -> `fetchJson` -> `parseForecast`
-> `hours[]` -> `evaluateHours` -> `findWindows`/`findNearMisses`/`pickBest`
-> `buildViewModel` -> render. Editing rules re-runs everything after
`fetchJson` locally; only a location or horizon change refetches.

## Milestones (TDD: tests first, see them fail, then implement)

Rule: don't start milestone N+1 until milestone N's exit criteria pass.

- [x] **M0 — Harness.** `package.json`, one trivial passing test, `npm run
      serve` serves a blank `docs/index.html`, `docs/.nojekyll`.
      Exit: `npm test` green; page loads at `http://localhost:8000`.
- [x] **M1 — Engine on hard-coded data (core de-risk).** `engine.js`,
      `tests/support/makeHours.js`, `tests/engine.test.js`, canonical
      scenario S1. No network, no UI, no parser.
      Exit: all engine tests in spec §12 pass; every rule type's behavior
      can be explained from first principles, no hand-waving.
- [x] **M2 — Real response, parser, time/DST.** `npm run capture` against
      real Open-Meteo endpoints; `forecast.js`, `timefmt.js`, `units.js`.
      Exit: parser + DST tests pass on real fixtures; §14 assumptions
      confirmed or spec amended. Kill/pivot check on null
      `precipitation_probability`/`dew_point_2m`.
- [x] **M3 — Rules, serialization, presets.** `rules.js`, `urlstate.js`,
      `presets.js`. Exit: every preset validates and evaluates on the real
      fixture; round-trip encode/decode passes.
- [x] **M4 — Near-misses, ranking, view-model.** `findNearMisses`,
      `viewmodel.js`. Exit: S1 near-miss expectations pass; sentences
      deterministic.
- [x] **M5 — UI on fixtures, no network.** `index.html`, `style.css`,
      `app.js`, `?fixture=name` dev flag. Exit: manual QA §13 items 1–6
      pass at phone width.
- [x] **M6 — Live data.** `geo.js`, `api.js` wired to UI, geolocation,
      error states. Exit: injected-fetch `ApiError` tests pass; manual QA
      items 7–10 pass locally.
- [x] **M7 — Ship.** README, push, enable Pages. Post-deploy smoke test
      (items 11–12) on the real `github.io` origin.

## Bonus ideas (deferred until v1 done)

- Stargazing: sunset/sunrise, moonset/moonrise, moon phase (dark-sky
  windows). **Confirmed 2026-09-19:** the forecast API's `daily` block
  returns `sunrise`, `sunset`, `moonrise`, `moonset` (local ISO strings;
  `moonset` can be `null` on days the moon doesn't set) and `moon_phase`
  (fraction 0..1, 0 = new, 0.5 = full). No pure-formula fallback needed.
  Same host, so no CSP change. Needs a `daily` parse path and a new rule
  type (e.g. `dark` = sun below horizon, moon down or phase < X) plus
  `cloud` range for clear skies; fits the existing engine model.
- Coastal wave forecasts: **Yes, confirmed 2026-09-19.** Open-Meteo has a **separate** Marine Weather
  API (`marine-api.open-meteo.com`) with wave height/period/direction —
  it is a different host, so CSP `connect-src` and the free-tier terms
  would both need updating if pursued. Treat as its own preset family
  (e.g. `surf-check`) added after v1, not folded into the land-forecast
  fetch.

## Decisions log

- 2026-09-19: Starting local-demo de-risk track first: M0 then M1, no
  network calls yet, to validate rule-engine semantics before touching
  parsing, UI, or live data — matches spec §11's explicit ordering and its
  own "core de-risk" label on M1.
- 2026-09-19: M2 unblocked (the earlier 403 was the other sandbox's egress
  proxy; this machine reaches Open-Meteo directly). Saved the full spec as
  `SPEC.md`, since PLAN.md only summarizes it.
- 2026-09-19: `timefmt.groupByLocalDay` returns
  `[{ dateKey, year, month, day, weekday, cells: [{ i, t, hour, minute, ambiguous }] }]`
  (`weekday` 0 = Sunday). The spec doesn't fix this shape; M4's viewmodel
  builds on it. Only the *second* repeated local hour is `ambiguous`, per
  spec §12.

## M2 findings (spec §14 checklist, from `tests/fixtures/`, captured 2026-09-19)

Fixtures: `npm run capture` writes 5 forecasts (New York, Denver, Sydney,
Reykjavik, open ocean at 0,-160), 2 geocodes, 2 error payloads, and
`_meta.json` (URLs, status, headers).

- **`past_days=1` -> 24 extra past hours: confirmed, with a nuance.** Every
  fixture has 192 hours = 8 x 24, and the first hour is *local midnight
  yesterday*, not now-24h. So real lookback is 24-47 h depending on time of
  day. Enough for `dry.before` <= 24 always. Tested.
- **`timezone=auto`: confirmed.** `timezone` (IANA, `Etc/GMT+11` for open
  ocean), `timezone_abbreviation` (`GMT-4` style, *not* `EDT`; use `Intl` for
  abbreviations), `utc_offset_seconds`, and `hourly_units` all present.
  Units: `°C`, `%`, `mm`, `km/h`; `uv_index` and `is_day` have empty-string
  units.
- **Null `precipitation_probability` / `dew_point_2m`: not seen.** Zero nulls
  in any variable across all 5 locations, including open ocean. The
  kill/pivot check passes: keep `maxProb` and `dewMargin`. This is a test
  (`forecast.test.js`), so a re-capture that shows nulls will fail loudly. The
  engine's `no-data` handling stays for regions/models we didn't sample.
- **Geocoding with no match: confirmed.** Response is
  `{"generationtime_ms": ...}` with no `results` key. Result fields are
  `latitude`, `longitude`, `timezone`, `country_code`, `admin1`, `id` etc.,
  so `normalizeGeocode` (M6) must map to `lat`/`lon`/`tz`.
- **Error payload: confirmed, with a spec amendment.** A bad request returns
  **HTTP 400** with `{"error": true, "reason": "..."}`. Spec §7 lists
  `api-error` as "payload flags an error" but doesn't say a 400 arrives
  first. **M6 `fetchJson` must parse the body of non-2xx responses (other
  than 429/5xx) and raise `api-error` with `reason`**, not a generic
  `bad-response`.
- **`time` strictly hourly: confirmed** on all 5 (no gaps). Gap-filling is
  still implemented and tested synthetically. `parseForecast` also rejects
  non-increasing or non-whole-hour steps, and gaps over 16 days.
- **429 behavior: not confirmed.** Can't be provoked politely on the free
  tier. `_meta.json` records `retry-after`/`x-ratelimit*` headers if any
  appear (none did). M6 handles 429 by status code alone; revisit if
  headers turn up.
- **CORS:** forecast, geocoding and marine hosts all return
  `access-control-allow-origin: *` (checked with curl and an `Origin`
  header). The real browser check is still spec §13 item 11 post-deploy.
- 2026-09-19 (M3): `validateRuleSet` *rejects* out-of-range `horizonDays`,
  duplicate/empty rule ids, and non-numeric `minHours` (ids identify
  near-miss blockers, so they must be unique), but *clamps* `minHours` to
  1..24 and dry `before`/`after` to integers 0..24, since those come from
  hand-editable links. It returns a normalized copy (unknown fields dropped).
- 2026-09-19 (M3): `units.js` gained unit *kinds* (`temp`, `tempDelta`,
  `speed`, `precip`, `pct`, `uv`) with `toDisplay`/`fromDisplay`/
  `displayNumber`/`roundTo`. `tempDelta` matters: a 3 °C dew-point margin is
  5.4 °F, not 37.4 °F. `geo.js` exists with only `roundCoord`; the rest is M6.
- 2026-09-19 (M3): `encodeState` leaves out `r` if the rule set is invalid,
  so a half-typed edit can't break the URL; decode then falls back to the
  default rules. Empty hash -> defaults with no warning (fresh visit); any
  other unreadable input -> defaults plus a warning for the "Couldn't read
  the shared link" banner. Hashes over 8000 chars are refused unparsed.
- Open question for M5: in imperial, the 0.1 mm/h rain threshold displays as
  "0.004 in/h". Correct but awkward; consider always showing precipitation in
  mm, or a friendlier step for the inch input.
- 2026-09-19 (M4): `findNearMisses` and the S1 expectation (12..19, `dry`,
  failCount 6) were already implemented and tested in M1, so M4 was the
  view-model. `buildViewModel` takes an **optional `rules` array** beyond the
  spec's input list: without it the hour detail can't say "Wind speed 31
  km/h > 25 km/h" or name a blocker, so it falls back to the rule id. Each
  cell's `fails[]` are engine fail records plus a `text` string.
- 2026-09-19 (M4): near-misses are ranked in the view-model (not the engine):
  fewest failing hours, then longest run, then earliest. Engine output order
  is unchanged. The UI should show `nearMisses.slice(0, 3)` when no window.
- 2026-09-19 (M4): window sentences run to the *end* of the last hour
  (hours 6..11 -> "Sat 6 AM to 12 PM (6 h)"), and add the end weekday only
  when the window crosses midnight. `hourLabel` now normalizes ICU's narrow
  no-break space to a plain space, so sentences don't vary by runtime.
  `rules.js` gained `ruleName` and `describeFail`; `timefmt.js` gained
  `dayLabel`.
- Note for M5: a near-miss can be a run where *every* hour fails one rule
  (spec-conformant; e.g. a whole daylight period with gusts over the limit).
  The sentence says "for all N h". Consider whether the UI should demote
  those, since they're less actionable than partial misses.

## M5 notes (UI on fixtures, 2026-09-19)

Exit criteria (spec §13 items 1-6) verified in headless Chromium at 360 px by
`npm run qa:browser` (`scripts/qa-browser.mjs`: no dependencies, own static
server, `CHROME_BIN` or auto-detects a Playwright Chromium; Node 22+). It
also checks keyboard navigation and that the console/CSP stay clean. M6
should extend it for items 7-10. Also checked by hand in screenshots: dark
mode, 900 px, and a fall-back DST day (25 columns, second 1 AM labeled
"1 AM EST") using a temporary time-shifted fixture (not committed).

- **Fixtures for the page:** `npm run dev:sync` (also run by `capture`) copies
  `tests/fixtures/forecast-*.json` to `docs/dev/` plus `manifest.json` with the
  capture time. In fixture mode "now" is that capture time (override with
  `?now=<epoch>`), so views are deterministic. `?fixture=<name>` picks one;
  with no flag the page defaults to `new-york`. Safe to leave in `docs/`.
- **Deviations from the spec text, all deliberate:**
  - CSP `connect-src` gains `'self'` so the page can fetch `./dev/*.json`.
    Revisit at M7 whether to keep it.
  - Result comes before Rules on the page (spec §1 "answer first"; §8 lists
    rules first).
  - View-model cells gained `hour` (local hour) so the grid can place cells by
    column on 23/25-hour days. Windows of 24 h or more now name full dates
    ("Sat, Sep 19 12 AM to Sat, Sep 26 12 AM"); without that, a week-long
    window read as "Sat ... to Sat".
  - The location card shows the sample's name and the attribution link; the
    search box, "Use my location" and lat/lon fallback are M6 (no dead
    controls in the meantime).
- **Grid:** status colors are the fixed status palette (good/warning/critical)
  with a glyph on every cell and a legend, so state is never color-alone.
  Cells are ~9 px wide at 360 px (spec's known risk): the mitigation is in
  (tap a day label for that day's hour list) plus arrow-key navigation with a
  single tab stop instead of 168. Windows are marked with an underline bar.
  Days that are entirely in the past are hidden.
- **Rule editing:** inputs remember their canonical value in `data-canon`; only
  the field you touch is rewritten, so display rounding (e.g. 84.2 F) never
  leaks into stored thresholds. An invalid edit shows the validator's message
  and keeps the last good result on screen.
- **Horizon:** in fixture mode the horizon selector slices the loaded
  forecast (1 past day + N days); a 14-day choice is a no-op on the 7-day
  samples. Real refetching is M6.
- **Saved rules** (localStorage `wwf:v1:saved`, max 20, validated on read) are
  implemented. **JSON export/import backup (spec §9) is not**; deferred to M7
  polish or v1.1.
- Not covered by automation: the page doesn't react to hash edits made in the
  same tab (only to a fresh load), which matches how links are shared.

## M6 notes (live data, 2026-09-19)

Exit criteria: injected-fetch tests cover every `ApiError` kind (`api.test.js`,
`geo.test.js`); spec §13 items 7-10 pass in `npm run qa:browser`, which now
answers Open-Meteo from `tests/fixtures/` (plus a fake 429, dropped connection
and 400) via CDP request interception and pins `Date.now` to the capture time,
so it is deterministic and never calls the real API. Also run once by hand
against the real APIs from a `localhost` origin: geocoding "Denver", pick the
first result, real forecast rendered (168 cells), no CORS or CSP errors.

- **`api.js`:** every non-2xx is classified: 429 -> `rate-limit`, 5xx ->
  `server`, other 4xx with `{error:true, reason}` -> `api-error` (this is the
  real HTTP 400 shape from the M2 captures), other 4xx / non-JSON 2xx ->
  `bad-response`. The timeout covers reading the body, not just the headers.
  `reason` is always a string capped at 500 chars.
- **`geo.js`:** `normalizeGeocode` maps the API's `latitude/longitude/timezone`
  to `lat/lon/tz`, skips results with unusable coordinates, and collapses
  adjacent duplicate label parts. Real data note: results aren't always named
  like the query (searching "Springfield" returned Palmyra, Missouri and
  Jackson, Minnesota, presumably via other matches), so the list shows the full
  label rather than assuming.
- **Fetch policy (`ensureForecast` in `app.js`):** a fetch happens only when
  (lat, lon, horizon) differs from what's loaded, so rule edits never refetch,
  and a horizon change (or a preset with a different horizon) does. A request
  token drops superseded responses. **A failed fetch keeps the last good
  forecast *and* the location it belongs to**; the new place only replaces
  them once its forecast loads, so a forecast is never shown under the wrong
  name. "Try again" retries the pending target.
- **Privacy/limits:** nothing is requested on load without a location;
  geolocation only on button click; search only after 3+ characters and a
  300 ms pause; coordinates are rounded to 2 dp *before* the request, so a
  shared link reproduces exactly the request that was made.
- **Error copy** follows §10. Beyond the spec, `rate-limit` also gets a retry
  button (harmless; the spec only lists one for network/timeout/server), and
  `timeout`/`server` have their own wording. Generic errors log details to the
  console and show no retry.
- **Fixture mode** (`?fixture=`) now hides the search controls and uses the
  capture time as "now"; live mode uses `Date.now()` on every evaluation, so
  "past" hours advance as the page stays open (the forecast itself is not
  auto-refreshed; reloading or re-picking the place refetches).
- Not done / for M7: 429 headers are still unobserved (status code alone is
  used); the JSON export/import backup remains deferred; the CSP `connect-src
  'self'` added in M5 is still there for the dev fixtures.

## M7 notes (ship, 2026-09-19)

- **Pages was already enabled** (source `main` `/docs`, public, HTTPS enforced)
  before M7 started, so nothing to switch on; it rebuilt from `main` after each
  merge. Live at https://jgarofoli.github.io/weatherwindow/.
- **Post-deploy smoke test** (`npm run smoke:deployed`, spec §13 items 11-12)
  passed against the real origin at `main` = `f04539d`: geocoding and forecast
  calls succeed with real CORS, no CSP/console errors, only same-origin and
  Open-Meteo hosts, attribution and disclaimer visible, zero cookies (both
  `document.cookie` and the browser cookie jar), and a shared live link
  reopens in a fresh browser.
- **Added `golden.test.js`** (spec §12 listed it, earlier milestones missed
  it): 5 fixtures x 3 presets = 15 files in `tests/golden/`, `nowT` pinned to
  the capture time. Reviewed by eye: pass blocks line up with daylight, New
  York paint's best window (hours 31..42) matches what the UI shows, and the
  open-ocean point has no paint windows. Regenerate only with
  `npm run golden:update`.
- **Shared browser driver:** `scripts/cdp.mjs` is now used by both
  `qa-browser.mjs` and `smoke-deployed.mjs`. `qa:browser` serves the site under
  `/weatherwindow/` like a Pages project site; a mutation check (absolute
  `/app.js`) confirmed it fails when a path isn't relative.
- **README** documents commands, deploy steps, architecture, privacy and the
  §14 findings.

### Definition of done (spec §16)

- [x] `npm test` green (184), every §12 test file exists and passes.
- [x] §13 items 1-10 pass locally (automated in `qa:browser`, in headless
      Chromium at 360 px); items 11-12 pass post-deploy (`smoke:deployed`).
      **Not done: a pass on a real phone.** Cells are ~9 px wide at 360 px, so
      this is the one thing worth eyeballing by hand.
- [x] Zero runtime dependencies (no dependencies of any kind); zero cookies;
      only Open-Meteo network calls (verified in code and on the live site).
- [x] Attribution link and disclaimer visible.
- [x] README documents commands, deploy steps and the §14 findings.

### Still open / v1.1 candidates

- JSON export/import of saved rules (spec §9), deferred.
- 429 response headers never observed.
- CSP `connect-src 'self'` only exists for the dev fixtures; could be removed
  if `docs/dev/` is dropped.
- Bonus ideas (stargazing, waves) are written up under "Bonus ideas" above and
  are confirmed feasible with Open-Meteo.
