// Bench-Gate: vergleicht den Lauf aus `npm run bench:scan` mit der Baseline in
// tests/benchmarks/bench-baseline.json. Die Baseline ist bewusst gerundet und
// die echten Einzelmediane sind nicht dokumentiert; ein Neuvermessen wuerde die
// Referenz still auf die Maschine des Bearbeiters ziehen (offener Punkt G-06,
// siehe `openPoints` in der Baseline).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CALIBRATION_NAME, evaluateMeasurement, parseMeasurementLine } from "./bench-gate-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const baselineFile = path.join(rootDir, "tests", "benchmarks", "bench-baseline.json");
const RUN_TIMEOUT_MS = 300_000;

// Der Kalibrierwert misst CPU-/IO-Arbeit. Nur diese Phasen skalieren mit ihm;
// die protonDb-Phase ist latenzgebunden (500 mal delay(5) je Anfrage) und
// behaelt die unskalierte Baseline, sonst reisst eine verkleinerte Schwelle
// sie auf schnellerer Hardware zu Unrecht.
const CPU_BOUND_PHASES = new Set(["local", "scanGames"]);

const args = process.argv.slice(2);
const skipRun = args.includes("--skip-run");

const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf-8"));
const benchOutputFile =
  process.env.PROTIUM_BENCH_FILE ??
  path.join(os.tmpdir(), `protium-scan-benchmark-${process.pid}.txt`);

const expected = new Set();
for (const scenario of Object.keys(baseline.scenarios ?? {})) {
  for (const phase of Object.keys(baseline.scenarios[scenario] ?? {})) {
    expected.add(`${scenario}.${phase}`);
  }
}
if (expected.size === 0) {
  console.error("[bench:gate] Baseline ohne erwartete Messpunkte.");
  process.exit(1);
}

if (!skipRun) {
  console.log("[bench:gate] Starte Benchmark vitest...");
  fs.rmSync(benchOutputFile, { force: true });
  const result = spawnSync("npm", ["run", "bench:scan"], {
    cwd: rootDir,
    stdio: "inherit",
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env, PROTIUM_BENCH_FILE: benchOutputFile },
  });
  if (result.status !== 0) {
    console.error("[bench:gate] Benchmark fehlgeschlagen oder Zeitlimit ueberschritten.");
    process.exit(1);
  }
}

if (!fs.existsSync(benchOutputFile)) {
  console.error(`[bench:gate] Ausgabedatei ${benchOutputFile} nicht gefunden.`);
  process.exit(1);
}

const outputContent = fs.readFileSync(benchOutputFile, "utf-8");

// Der Kalibrierwert kommt aus demselben Lauf und skaliert die Baseline auf die
// aktuelle Maschine. Fehlt er (alte Baseline, alter Benchmark), bleibt der
// Faktor 1 und das Gate verhaelt sich wie vorher. Tag und Feldformat der
// Messzeilen kommen aus bench-gate-lib.mjs, derselben quelle wie im Writer.
let calibrationNow = Number.NaN;
const measurements = [];
for (const line of outputContent.split(/\r?\n/)) {
  const measurement = parseMeasurementLine(line);
  if (measurement === null) continue;
  if (measurement.name === CALIBRATION_NAME) calibrationNow = measurement.median;
  else measurements.push(measurement);
}
const calibrationBase = baseline.calibrationMs;
const calibrationFactor =
  Number.isFinite(calibrationNow) && typeof calibrationBase === "number" && calibrationBase > 0
    ? calibrationNow / calibrationBase
    : 1;
console.log(
  `[bench:gate] Kalibrierung: aktuell ${Number.isFinite(calibrationNow) ? calibrationNow.toFixed(2) : "?"} ms, ` +
    `Baseline ${typeof calibrationBase === "number" ? calibrationBase.toFixed(2) : "?"} ms, Faktor ${calibrationFactor.toFixed(2)}`,
);

const seen = new Set();
let failed = false;

for (const { name, median: medianMs } of measurements) {
  const separator = name.indexOf(".");
  if (separator <= 0) continue;
  const scenario = name.slice(0, separator);
  const phase = name.slice(separator + 1);
  const key = name;
  seen.add(key);

  const maxThreshold = baseline.maxThresholdMs?.[phase];
  const baseMs = baseline.scenarios?.[scenario]?.[phase];
  const maxRegressionPct = baseline.maxAllowedRegressionPercent;

  if (typeof maxThreshold !== "number" || typeof maxRegressionPct !== "number") {
    console.error(`[bench:gate] FEHLER: Baseline ohne Schwelle fuer ${key}.`);
    failed = true;
    continue;
  }

  const result = evaluateMeasurement({
    medianMs,
    baseMs,
    maxThreshold,
    maxRegressionPct,
    calibrationFactor,
    cpuBound: CPU_BOUND_PHASES.has(phase),
    foreignHardwareFactor: baseline.foreignHardwareFactor,
    maxRegressionPctForeign: baseline.maxAllowedRegressionPercentOnForeignHardware,
  });
  const allowedText =
    typeof result.allowed === "number" ? `${result.allowed.toFixed(1)} ms` : "unbekannt";
  if (result.ok) {
    console.log(
      `[bench:gate] OK: ${key} = ${medianMs.toFixed(1)} ms ` +
        `(Baseline: ${baseMs ?? "-"} ms, Toleranz: ${result.tolerancePct ?? maxRegressionPct} Prozent, erlaubt: ${allowedText})`,
    );
  } else {
    failed = true;
    console.error(
      `[bench:gate] FEHLER: ${key} = ${medianMs.toFixed(1)} ms, erlaubt ${allowedText}; ` +
        `gerissen: ${result.reason}`,
    );
  }
}

const missing = [...expected].filter((key) => !seen.has(key));
if (missing.length > 0) {
  console.error(`[bench:gate] FEHLER: Messpunkte fehlen: ${missing.join(", ")}`);
  process.exit(1);
}

if (failed) {
  console.error("[bench:gate] Performance-Gate fehlgeschlagen!");
  process.exit(1);
}

console.log(`[bench:gate] Alle ${seen.size} Messpunkte erfuellen die Vorgaben.`);
