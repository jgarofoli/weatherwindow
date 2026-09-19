# Weather Window Finder

When is the weather good for X? Give it rules ("air temperature 10 to 29 °C, at least 3 °C above the dew point, no rain for 4 h before and 8 h after, daylight, at least 6 hours long") and it finds the windows in the hourly forecast where **all** of them hold, shows the best one first, and explains why the other hours don't qualify.

Live: <https://jgarofoli.github.io/weatherwindow/>

It's a static site: no build step, no framework, no runtime dependencies, no server, no cookies, no analytics. All logic runs in your browser. The only network calls go to [Open-Meteo](https://open-meteo.com/).

> Decision aid, not a guarantee. Forecast skill drops with lead time. Presets are starting points; check your product's datasheet.

## Using it

1. Search for a place (3+ characters), use your location, or enter coordinates.
2. Pick a preset (exterior paint, hanging laundry, bike commute) or edit the rules. Every number is editable; changes re-evaluate instantly and never refetch.
3. Read the result: the best window, the day-by-hour grid (✓ all rules pass, ~ exactly one fails, ✕ fails, · past), the list of windows, and the closest misses. Tap an hour for the exact rules that fail (value against limit), or a day label for that whole day.
4. "Copy link" puts your location, units and rules in the URL hash so you can share exactly what you see. The hash is never sent to any server.

### The rules

All rules must hold for an hour to pass; a window is a run of consecutive passing hours at least "minimum window" long.

| Rule | Passes when |
|---|---|
| Range | a metric (air or feels-like temperature, humidity, wind, gusts, rain chance, UV, cloud cover) is within an inclusive min and/or max |
| Dew-point margin | air temperature minus dew point is at least the minimum |
| Dry spell | every hour from *N* h before to *M* h after is at or under a rain limit (and optionally a rain-chance limit) |
| Daylight | the sun is up |

Missing data fails conservatively (reported as "No data"). Thresholds are stored in °C, km/h and mm; imperial is display-only and never rounds what's stored.

## Commands

Node 20+ for the app and unit tests. The browser scripts need Node 22+ (global `WebSocket`) and a Chromium.

| Command | What it does |
|---|---|
| `npm run serve` | Serve `docs/` at <http://localhost:8000> (ES modules don't load from `file://`) |
| `npm test` | Unit tests plus golden tests (`node:test`, no dependencies) |
| `npm run test:watch` | Same, re-running on change |
| `npm run golden:update` | Regenerate `tests/golden/` after an *intended* behavior change; review the diff by eye |
| `npm run capture` | Save fresh Open-Meteo responses to `tests/fixtures/` and sync the dev copies in `docs/dev/` |
| `npm run dev:sync` | Only re-copy fixtures to `docs/dev/` |
| `npm run qa:browser` | Spec §13 manual QA items 1–10 in headless Chromium, with Open-Meteo answered from fixtures (offline, deterministic) |
| `npm run smoke:deployed` | Post-deploy check on the real origin against the real APIs (§13 items 11–12) |

The browser scripts find a Playwright-installed Chromium automatically; otherwise set `CHROME_BIN=/path/to/chrome`.

### Developing without the network

Open `http://localhost:8000/?fixture=new-york` (also `denver`, `sydney`, `reykjavik`, `mid-pacific`) to run the whole UI on a captured forecast. In that mode "now" is the capture time, so the view is stable; add `&now=<epoch seconds>` to move it.

## Deploying

GitHub Pages serves this repo's `docs/` folder from `main`:

1. Repo **Settings → Pages → Build and deployment**: Source *Deploy from a branch*, Branch `main`, folder `/docs`.
2. Run `npm test` and `npm run qa:browser` locally.
3. Push to `main`. Pages rebuilds in about a minute.
4. Run `npm run smoke:deployed`. CORS and CSP can only be verified on the real origin, not from localhost.

Project Pages serve under `/<repo>/`, so every path is relative (`./lib/engine.js`). `qa:browser` serves the site under `/weatherwindow/` to catch any absolute path.

## How it's built

Pure core, thin shell. Everything with logic is a pure function in `docs/lib/` (no `Date.now()`, no `fetch`, no DOM unless injected); `docs/app.js` only wires DOM events to it.

```
location -> buildForecastUrl -> fetchJson -> parseForecast -> hours[]
  -> evaluateHours(hours, rules) -> findWindows / findNearMisses / pickBest
  -> buildViewModel -> render
```

| Module | Role |
|---|---|
| `engine.js` | Evaluate hours against rules, find windows and near-misses, pick the best |
| `rules.js`, `presets.js`, `units.js` | Rule schema, validation, sentences; starter rule sets; unit conversions |
| `forecast.js`, `timefmt.js` | Build and parse the API request/response; timezone and DST-safe day grouping |
| `geo.js`, `api.js` | Geocoding helpers; `fetchJson` with typed `ApiError`s |
| `urlstate.js`, `viewmodel.js` | Shareable URL hash; engine output to render-ready structure and sentences |

Security: all API- and user-derived text is set with `textContent` (no `innerHTML`), and a CSP meta tag limits scripts to the page's own origin and network access to Open-Meteo (plus same-origin for the dev fixtures).

`SPEC.md` is the full spec and `PLAN.md` tracks milestones, decisions and findings.

## What the real API does (spec §14, confirmed from captured fixtures)

- `past_days=1` returns 24 extra past hours, starting at *local midnight yesterday* rather than now minus 24 h, so lookback is really 24–47 h. Plenty for "dry before" rules (max 24 h).
- `timezone=auto` fills `timezone` (IANA name), `timezone_abbreviation` (like `GMT-4`, not `EDT`, so abbreviations come from `Intl`) and `utc_offset_seconds`. `hourly_units` are `°C`, `%`, `mm`, `km/h` as requested.
- `precipitation_probability` and `dew_point_2m` were never null in any captured location, including open ocean, so both stay. Missing values are still handled (as "No data") for places we didn't sample.
- The `time` array is strictly hourly. Gaps are still filled with "missing" hours defensively.
- A place search with no match returns an object with no `results` key. Results use `latitude`, `longitude` and `timezone`, which are mapped to `lat`, `lon`, `tz`.
- **A bad request returns HTTP 400 with `{"error": true, "reason": "..."}`**, not a 200. The client reads the body of such responses and reports it as an `api-error` carrying the reason.
- Not confirmed: the headers on a 429 response (can't be provoked politely). Rate limiting is detected by status code alone.
- CORS: the forecast, geocoding and marine hosts all send `access-control-allow-origin: *`, and the deployed site was verified end to end (`npm run smoke:deployed`).

## Privacy and limits

- No cookies, no analytics. The only storage is `localStorage` (`wwf:v1:saved`), written only when you press "Save rules".
- Your location is only requested when you press "Use my location". Coordinates are rounded to about 1 km before use and before they go into a shared link.
- Open-Meteo's free tier is for non-commercial use (under 10,000 calls a day, 5,000 an hour, 600 a minute), with attribution: "Weather data by Open-Meteo.com" is shown next to the location. Searches wait for 3+ characters and a 300 ms pause; editing rules never refetches.

## Not in v1

Notifications, accounts, comparing locations, multi-model spread, surface-temperature estimates, JSON export/import of saved rules. Ideas that fit later, both confirmed possible with Open-Meteo: stargazing (the forecast's `daily` block has sunrise, sunset, moonrise, moonset and `moon_phase`) and wave forecasts for surfing (a separate Marine API host, which would need a CSP and terms update). See `PLAN.md`.

## License

CC0 1.0 Universal (public domain dedication); see [LICENSE](LICENSE). Weather data is provided by [Open-Meteo](https://open-meteo.com/) under its own [terms](https://open-meteo.com/en/terms).
