/**
 * Schwellenlogik des Bench-Gates, getrennt vom Skript, damit sie prüfbar ist.
 * Beide Schwellen gelten: die relative Regression zur Baseline UND die
 * absolute Obergrenze. Vorher war die absolute Schwelle wirkungslos, sobald
 * ein Baseline-Wert existierte.
 *
 * G-01: Der Rumpf liegt seit dem Audit in der Typprüfung (die frühere
 * `.d.mts`-Deklaration verdrängte die `.mjs` aus dem Programm, `npm run
 * check` sah den Rumpf nie). Deshalb die JSDoc-Typen unten statt separater
 * Deklarationsdatei; ohne sie würde `checkJs` die Destrukturierung und
 * `scaledBase` als implizit `any`/possibly undefined melden.
 */

// Tag und Feldreihenfolge der Messzeilen stehen nur hier. Writer
// (tests/benchmarks/scan.bench.ts) und Parser (scripts/bench-scan-gate.mjs)
// ziehen beide daraus, sonst meldet ein umbenannter Tag still
// "Messpunkte fehlen", statt zu scheitern.
export const BENCH_TAG = "[scan benchmark]";
export const CALIBRATION_NAME = "calibration";

/**
 * Baut eine Messzeile im gemeinsamen Format.
 * @param {string} name
 * @param {readonly number[]} values
 * @param {number} median
 * @returns {string}
 */
export function formatMeasurementLine(name, values, median) {
  const max = values.length === 0 ? median : Math.max(...values);
  return `${BENCH_TAG} ${name}Ms raw=${JSON.stringify(values)} median=${median} max=${max}`;
}

const ESCAPED_TAG = BENCH_TAG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MEASUREMENT_LINE_RE = new RegExp(
  `^${ESCAPED_TAG}\\s+([A-Za-z0-9.]+?)Ms\\s+raw=(\\[[^\\]]*\\])\\s+median=([0-9.]+)`,
);

/**
 * Liest eine Messzeile, die `formatMeasurementLine` geschrieben hat.
 * @param {string} line
 * @returns {{ name: string, values: number[], median: number } | null}
 */
export function parseMeasurementLine(line) {
  const match = MEASUREMENT_LINE_RE.exec(line.trim());
  if (match === null) return null;
  const name = match[1];
  const median = Number.parseFloat(match[3] ?? "");
  if (name === undefined || !Number.isFinite(median)) return null;
  let values = [];
  try {
    const parsed = JSON.parse(match[2] ?? "[]");
    if (Array.isArray(parsed)) values = parsed;
  } catch {
    return null;
  }
  return { name, values, median };
}

/**
 * @typedef {object} MeasurementInput
 * @property {number} medianMs gemessener Median der Phase
 * @property {number} [baseMs] unskalierte Referenz-Baseline der Phase
 * @property {number} [maxThreshold] absolute Obergrenze der Phase
 * @property {number} [maxRegressionPct] relative Toleranz zur Baseline
 * @property {number} [calibrationFactor] CPU-Kalibrierfaktor der aktuellen Maschine
 * @property {boolean} [cpuBound] ob die Phase mit dem Kalibrierfaktor skaliert werden darf (Default true)
 * @property {number} [foreignHardwareFactor] ab diesem Faktor gilt die weitere Toleranz
 * @property {number} [maxRegressionPctForeign] weitere Toleranz auf fremder Hardware
 */

/**
 * @typedef {object} MeasurementResult
 * @property {boolean} ok
 * @property {number} [allowed] engste erlaubte Zeit in ms
 * @property {number} [tolerancePct] angewandte relative Toleranz
 * @property {string} [reason] Begruendung, wenn ok false
 */

/**
 * Bewertet einen Messwert gegen Baseline und absolute Obergrenze.
 * @param {MeasurementInput} input
 * @returns {MeasurementResult}
 */
export function evaluateMeasurement(input) {
  const {
    medianMs,
    baseMs,
    maxThreshold,
    maxRegressionPct,
    calibrationFactor = 1,
    cpuBound = true,
    foreignHardwareFactor = 1.5,
    maxRegressionPctForeign,
  } = input;

  // Die Baseline wurde auf einer konkreten Maschine gemessen. Der
  // Kalibrierwert aus demselben Lauf skaliert sie auf die aktuelle Maschine,
  // sonst waere das Gate an die Hardware des Entwicklungsrechners gebunden
  // (gemessen: der CI-Runner ist rund 2,6-fach langsamer).
  const factor =
    Number.isFinite(calibrationFactor) && calibrationFactor > 0 ? calibrationFactor : 1;
  // Der Kalibrierwert misst reine CPU-/IO-Arbeit. Latenzgebundene Phasen wie
  // protonDb bestehen fast nur aus festen Wartezeiten (500 mal delay(5)); die
  // schrumpfen auf schnellerer Hardware nicht. Eine mit dem CPU-Faktor
  // skalierte Schwelle wuerde sie dort faelschlich reissen, also bleibt fuer
  // `cpuBound === false` die unskalierte Baseline und Obergrenze gueltig.
  const appliedFactor = cpuBound ? factor : 1;
  // Auf geteilter Hardware streuen die Messwerte staerker (gemessen: 6 Prozent
  // auf dem Entwicklungsrechner, 13 Prozent auf dem CI-Runner bei gleichem
  // Code). Dort gilt deshalb die weitere Toleranz aus der Baseline.
  const tolerancePct =
    factor > foreignHardwareFactor && typeof maxRegressionPctForeign === "number"
      ? maxRegressionPctForeign
      : maxRegressionPct;
  const scaledBase = typeof baseMs === "number" ? baseMs * appliedFactor : undefined;
  const scaledThreshold =
    typeof maxThreshold === "number" ? maxThreshold * appliedFactor : undefined;
  const relativeLimit =
    scaledBase !== undefined && typeof tolerancePct === "number"
      ? scaledBase * (1 + tolerancePct / 100)
      : undefined;
  const limits = [relativeLimit, scaledThreshold].filter((value) => typeof value === "number");
  if (limits.length === 0) {
    return { ok: false, allowed: undefined, reason: "keine Schwelle definiert" };
  }
  const allowed = Math.min(...limits);
  if (medianMs <= allowed) return { ok: true, allowed, tolerancePct, reason: undefined };

  const broken = [];
  if (relativeLimit !== undefined && scaledBase !== undefined && medianMs > relativeLimit) {
    broken.push(
      `Baseline ${scaledBase.toFixed(1)} ms (kalibriert, Faktor ${appliedFactor.toFixed(2)}) plus ${tolerancePct} Prozent = ${relativeLimit.toFixed(1)} ms`,
    );
  }
  if (scaledThreshold !== undefined && medianMs > scaledThreshold) {
    broken.push(`absolute Obergrenze ${scaledThreshold.toFixed(1)} ms (kalibriert)`);
  }
  return { ok: false, allowed, tolerancePct, reason: broken.join(" und ") };
}
