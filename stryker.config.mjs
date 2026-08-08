// stryker-mutationstesting: nur src/core (UI-frei, headless gegen fixtures).
// kein rust (stryker kann kein rust), keine UI-dateien. lauf: npm run mutation
// (manuell oder in CI, artefakte sind nicht committet).
// blocklist.ts: die datentabelle (zeile 18-51) wird ausgenommen — ihre
// string-mutanten sind prinzipiell nicht tötbar (ein test, der ein label
// pinnt, dupliziert nur die daten) und verzerrten den score; isBlocked und
// availableBuiltinProtons bleiben drin. siehe docs/mutation-report.
// @ts-check
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
  disableProgress: true,
};

export default config;
