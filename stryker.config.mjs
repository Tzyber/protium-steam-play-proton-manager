// stryker-mutationstesting: nur src/core (UI-frei, headless gegen fixtures).
// kein rust (stryker kann kein rust), keine UI-dateien. lauf: npm run mutation
// (manuell oder in CI, artefakte sind nicht committet).
// blocklist.ts: mutiert wird nur der logikbereich unten (BLOCKLIST_LOGIC_RANGE),
// nicht die datentabelle davor. die string-mutanten der tabelle sind nur durch
// daten-pinning tötbar (ein test, der ein label pinnt, dupliziert nur die
// daten) und verzerrten den score; die namens-präfixe und blockReason /
// availableBuiltinProtons bleiben drin, weil ihre mutanten das verhalten
// ändern. score-effekt der korrigierten range: sie schneidet die zuvor
// mitgezählten tabellenzeilen ab und nimmt availableBuiltinProtons dazu; die
// alte referenz (ist 74,45 % am 2026-08-27, noch vor der range-korrektur) ist
// damit nur eingeschränkt vergleichbar. nachgemessen am 2026-09-26 mit der
// korrigierten range: ist 81,17 %, break 69 bleibt die grundlage. siehe
// docs/mutation-report-2026-08-08.md.
// @ts-check
// .stryker-tmp bleibt ein temporäres Stryker-Arbeitsverzeichnis und gehört
// weder in Biome- noch in TypeScript-Prüfungen.
/** Der mutierbare logikbereich in blocklist.ts: ab BLOCKED_IDS bis zum Ende
 *  von isManifestToolName. Die datentabelle (Zeilen davor) bleibt
 *  ausgenommen, sonst mutiert stryker nur nachschlage-daten. */
const BLOCKLIST_LOGIC_RANGE = "91-139";
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  mutate: [
    "src/core/**/*.ts",
    "!src/core/blocklist.ts",
    `src/core/blocklist.ts:${BLOCKLIST_LOGIC_RANGE}`,
    "src/ui/consequences.ts",
    "src/ui/formatError.ts",
    "src/ui/sizeSummary.ts",
    "src/ui/stores/confirmStore.ts",
    "src/ui/stores/cleanupHelpers.ts",
  ],
  concurrency: 8,
  reporters: ["clear-text", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/html/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation-report.json" },
  // gemessen 2026-10-06 mit den fünf UI-Dateien dazu: 81,75 % bei 3738
  // mutanten. davor 81,17 % am 2026-09-26 und 74,45 % am 2026-08-27.
  // break 69 bleibt unter dem ist mit puffer; high/low sind ziel-marken.
  thresholds: { high: 80, low: 60, break: 69 },
};

export default config;
