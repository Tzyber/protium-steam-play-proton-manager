// stryker-mutationstesting: nur src/core (UI-frei, headless gegen fixtures).
// kein rust (stryker kann kein rust), keine UI-dateien. lauf: npm run mutation
// (manuell oder in CI, artefakte sind nicht committet).
// blocklist.ts: die datentabelle (zeile 18-51) wird ausgenommen, ihre
// string-mutanten sind prinzipiell nicht tötbar (ein test, der ein label
// pinnt, dupliziert nur die daten) und verzerrten den score; isBlocked und
// availableBuiltinProtons bleiben drin. siehe docs/mutation-report.
// @ts-check
// .stryker-tmp bleibt ein temporäres Stryker-Arbeitsverzeichnis und gehört
// weder in Biome- noch in TypeScript-Prüfungen.
/** @type {import('@stryker-mutator/core').StrykerOptions} */
const config = {
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  mutate: [
    "src/core/**/*.ts",
    "!src/core/blocklist.ts",
    "src/core/blocklist.ts:53-77",
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
