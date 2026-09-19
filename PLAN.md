# Weather Window Finder — Plan

Static, no-build, no-dependency site on GitHub Pages (`docs/`) that finds
windows in an hourly forecast where all of a user's rules hold for a
minimum consecutive-hour run. Full spec is in the task description that
generated this plan; this file tracks milestone status and decisions made
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

- [ ] **M0 — Harness.** `package.json`, one trivial passing test, `npm run
      serve` serves a blank `docs/index.html`, `docs/.nojekyll`.
      Exit: `npm test` green; page loads at `http://localhost:8000`.
- [ ] **M1 — Engine on hard-coded data (core de-risk).** `engine.js`,
      `tests/support/makeHours.js`, `tests/engine.test.js`, canonical
      scenario S1. No network, no UI, no parser.
      Exit: all engine tests in spec §12 pass; every rule type's behavior
      can be explained from first principles, no hand-waving.
- [ ] **M2 — Real response, parser, time/DST.** `npm run capture` against
      real Open-Meteo endpoints; `forecast.js`, `timefmt.js`, `units.js`.
      Exit: parser + DST tests pass on real fixtures; §14 assumptions
      confirmed or spec amended. Kill/pivot check on null
      `precipitation_probability`/`dew_point_2m`.
- [ ] **M3 — Rules, serialization, presets.** `rules.js`, `urlstate.js`,
      `presets.js`. Exit: every preset validates and evaluates on the real
      fixture; round-trip encode/decode passes.
- [ ] **M4 — Near-misses, ranking, view-model.** `findNearMisses`,
      `viewmodel.js`. Exit: S1 near-miss expectations pass; sentences
      deterministic.
- [ ] **M5 — UI on fixtures, no network.** `index.html`, `style.css`,
      `app.js`, `?fixture=name` dev flag. Exit: manual QA §13 items 1–6
      pass at phone width.
- [ ] **M6 — Live data.** `geo.js`, `api.js` wired to UI, geolocation,
      error states. Exit: injected-fetch `ApiError` tests pass; manual QA
      items 7–10 pass locally.
- [ ] **M7 — Ship.** README, push, enable Pages. Post-deploy smoke test
      (items 11–12) on the real `github.io` origin.

## Bonus ideas (deferred until v1 done)

- Stargazing: sunset/sunrise, moonset/moonrise, moon phase (dark-sky
  windows). Open-Meteo's forecast API returns `sunrise`/`sunset` in the
  daily block already; moon phase needs a separate calc (no free-tier
  Open-Meteo field for it as of this writing — confirm at M2/M6, else use
  a small pure astronomical formula, no extra network dependency).
- Coastal wave forecasts: Open-Meteo has a **separate** Marine Weather
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
- 2026-09-19: M0 and M1 complete (30/30 tests green); PR #1 opened and
  marked ready for review.
- 2026-09-19: M2 ("real capture") is blocked in this remote sandbox — its
  egress proxy returns 403 for both `api.open-meteo.com` and
  `geocoding-api.open-meteo.com` (confirmed via the proxy status endpoint,
  `connect_rejected` / "policy denial", not a transient failure). Paused
  work here at the user's direction; M2 continues on a machine with
  outbound network access. Resume with `npm run capture` (writes to
  `tests/fixtures/`), per spec §11 M2 and the §14 checklist of assumptions
  to confirm from the real response (past_days lookback, timezone/
  utc_offset_seconds population, hourly_units strings, nullability of
  precipitation_probability, geocoding no-results shape, error payload
  shape, gaps in the hourly time array, 429 behavior).
