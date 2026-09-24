// stryker-mutationstesting: nur src/core (UI-frei, headless gegen fixtures).
// kein rust (stryker kann kein rust), keine UI-dateien. lauf: npm run mutation
// (manuell oder in CI, artefakte sind nicht committet).
// blocklist.ts: mutiert wird nur der logikbereich unten (BLOCKLIST_LOGIC_RANGE),
// nicht die datentabelle davor. die string-mutanten der tabelle sind nur durch
// daten-pinning tötbar (ein test, der ein label pinnt, dupliziert nur die
// daten) und verzerrten den score; die namens-präfixe und blockReason /
// availableBuiltinProtons bleiben drin, weil ihre mutanten das verhalten
// ändern. score-effekt der korrigierten range: sie schneidet die zuvor
// mitgezählten tabellenzeilen ab und nimmt availableBuiltinProtons dazu, ein
// neuer messwert wurde dafür nicht erhoben; die referenz aus dem letzten
// vollauf (ist 74,45 %, break 69) bleibt deshalb die grundlage. siehe
// docs/mutation-report.
// @ts-check
// .stryker-tmp bleibt ein temporäres Stryker-Arbeitsverzeichnis und gehört
// weder in Biome- noch in TypeScript-Prüfungen.
/** Der mutierbare logikbereich in blocklist.ts: ab BLOCKED_IDS bis zum Ende
 *  von availableBuiltinProtons. Die datentabelle (Zeilen davor) bleibt
 *  ausgenommen, sonst mutiert stryker nur nachschlage-daten. */
const BLOCKLIST_LOGIC_RANGE = "57-85";
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  mutate: [
    "src/core/**/*.ts",
    "!src/core/blocklist.ts",
    `src/core/blocklist.ts:${BLOCKLIST_LOGIC_RANGE}`,
  ],
  concurrency: 8,
  reporters: ["clear-text", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/html/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation-report.json" },
  // gemessener ist-score am 2026-08-27: 74,45 % (stryker-volltest, 2:53 min).
  // break 69 bleibt unter dem ist mit puffer für schwankungen; high/low sind
  // ziel-marken, kein gate.
  thresholds: { high: 80, low: 60, break: 69 },
};

export default config;
