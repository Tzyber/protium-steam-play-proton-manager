import { describe, expect, it } from "vitest";
import {
  BENCH_TAG,
  CALIBRATION_NAME,
  evaluateMeasurement,
  formatMeasurementLine,
  parseMeasurementLine,
} from "../../scripts/bench-gate-lib.mjs";

// Writer (tests/benchmarks/scan.bench.ts) und Parser (scripts/bench-scan-gate.mjs)
// teilen Tag und Feldformat über bench-gate-lib.mjs. Der Test hält Hin- und
// Rückrichtung zusammen: ein umbenannter Tag fällt hier auf, statt im Gate
// still "Messpunkte fehlen" zu melden (G-04).
describe("bench-gate Messzeilen", () => {
  it("liest genau zurück, was der Writer schreibt", () => {
    const values = [40.2, 45.7, 43.1];
    const line = formatMeasurementLine("cold.local", values, 43.1);
    expect(line.startsWith(BENCH_TAG)).toBe(true);
    expect(parseMeasurementLine(line)).toEqual({
      name: "cold.local",
      values,
      median: 43.1,
    });
  });

  it("erkennt auch die Kalibrierzeile mit leerem wertefeld", () => {
    const line = formatMeasurementLine(CALIBRATION_NAME, [], 6.23);
    expect(parseMeasurementLine(line)).toEqual({
      name: CALIBRATION_NAME,
      values: [],
      median: 6.23,
    });
  });

  it("gibt für fremde zeilen null zurück", () => {
    expect(parseMeasurementLine("laufzeit: 40 ms")).toBeNull();
    expect(parseMeasurementLine(`[scan benchmark] cold.localMs median=4`)).toBeNull();
  });
});

describe("bench-gate Kalibrierung", () => {
  // Belegter Befund: die protonDb-Phase fuehrt 500 feste delay(5) aus, ihre
  // Messzeit schrumpft auf schnellerer Hardware nicht. Eine mit dem CPU-Faktor
  // skalierte Schwelle riss sie auf dieser Maschine faelschlich (2537 ms gegen
  // 2335 ms bei Faktor 0.72). Mit cpuBound=false gilt die unskalierte
  // Baseline; der Faktor bleibt fuer die CPU-gebundenen Phasen wirksam.
  it("skaliert latenzgebundene Phasen nicht mit dem CPU-Faktor", () => {
    const latencyBound = evaluateMeasurement({
      medianMs: 2537,
      baseMs: 2580,
      maxThreshold: 3500,
      maxRegressionPct: 25,
      calibrationFactor: 0.72,
      cpuBound: false,
    });
    expect(latencyBound.ok).toBe(true);
    // 2580 ms + 25 Prozent, ohne den Faktor 0.72.
    expect(latencyBound.allowed).toBeCloseTo(3225, 1);

    // Dieselbe Messung in einer CPU-gebundenen Phase bleibt rot: dort wirkt
    // der Faktor weiterhin (2580 * 0.72 * 1.25 = 2322 ms).
    const cpuBound = evaluateMeasurement({
      medianMs: 2537,
      baseMs: 2580,
      maxThreshold: 3500,
      maxRegressionPct: 25,
      calibrationFactor: 0.72,
      cpuBound: true,
    });
    expect(cpuBound.ok).toBe(false);
    expect(cpuBound.allowed).toBeCloseTo(2322, 1);
  });
});
