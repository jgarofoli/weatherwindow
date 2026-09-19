// Copies the captured forecast fixtures into docs/dev/ so the page can load them via ?fixture=name
// (spec §11 M5). Also writes manifest.json with the capture time, which the page uses as "now" so
// fixture views are deterministic. Runs at the end of `npm run capture`; run alone with `npm run dev:sync`.
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "tests", "fixtures");
const DEST = path.join(root, "docs", "dev");

const LABELS = {
  "new-york": "New York",
  denver: "Denver",
  sydney: "Sydney",
  reykjavik: "Reykjavik",
  "mid-pacific": "Open ocean (mid-Pacific)",
};

await mkdir(DEST, { recursive: true });
const { capturedAt } = JSON.parse(await readFile(path.join(SRC, "_meta.json"), "utf8"));
const fixtures = [];
for (const file of (await readdir(SRC)).filter((f) => /^forecast-.+\.json$/.test(f)).sort()) {
  const name = file.slice("forecast-".length, -".json".length);
  await copyFile(path.join(SRC, file), path.join(DEST, `${name}.json`));
  fixtures.push({ name, label: LABELS[name] ?? name });
}
await writeFile(path.join(DEST, "manifest.json"), JSON.stringify({ capturedAt, fixtures }, null, 1) + "\n");
console.log(`synced ${fixtures.length} fixtures to docs/dev/ (capturedAt ${capturedAt})`);
