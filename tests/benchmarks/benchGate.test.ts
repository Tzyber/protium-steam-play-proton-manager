import { describe, expect, it } from "vitest";
import { evaluateMeasurement } from "../../scripts/bench-gate-lib.mjs";

describe("bench-gate schwellen (N5)", () => {
  it("lässt einen wert durch, der beide schwellen einhält", () => {
    const result = evaluateMeasurement({
      medianMs: 45,
      baseMs: 40,
      maxThreshold: 120,
      maxRegressionPct: 25,
    });
    expect(result.ok).toBe(true);
    expect(result.allowed).toBe(50);
  });

  it("greift bei relativer regression zur baseline", () => {
    const result = evaluateMeasurement({
      medianMs: 60,
      baseMs: 40,
      maxThreshold: 120,
      maxRegressionPct: 25,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Baseline");
  });

  it("greift bei der absoluten obergrenze, auch wenn die baseline sie nicht reißt", () => {
    // genau der tote zweig: baseMs existiert, die absolute schwelle ist enger.
    const result = evaluateMeasurement({
      medianMs: 60,
      baseMs: 100,
      maxThreshold: 50,
      maxRegressionPct: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("absolute Obergrenze");
  });

  it("nennt beide gründe, wenn beide schwellen gerissen sind", () => {
    const result = evaluateMeasurement({
      medianMs: 500,
      baseMs: 40,
      maxThreshold: 120,
      maxRegressionPct: 25,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Baseline");
    expect(result.reason).toContain("absolute Obergrenze");
  });

  it("skaliert die baseline mit dem kalibrierwert der aktuellen maschine", () => {
    // Der Runner ist langsamer: Faktor 3 hebt die erlaubte Zeit im selben
    // Verhaeltnis, damit das Gate maschinenunabhaengig bleibt.
    const slower = evaluateMeasurement({
      medianMs: 120,
      baseMs: 45,
      maxThreshold: 120,
      maxRegressionPct: 25,
      calibrationFactor: 3,
    });
    expect(slower.ok).toBe(true);
    expect(slower.allowed).toBeCloseTo(168.75, 2);

    // Ein Ausreisser jenseits der skalierten Schwelle bleibt ein Fehler.
    const tooSlow = evaluateMeasurement({
      medianMs: 200,
      baseMs: 45,
      maxThreshold: 120,
      maxRegressionPct: 25,
      calibrationFactor: 3,
    });
    expect(tooSlow.ok).toBe(false);
    expect(tooSlow.reason).toContain("kalibriert");
  });

  it("behandelt einen fehlenden oder unsinnigen faktor als 1", () => {
    const withoutFactor = evaluateMeasurement({
      medianMs: 45,
      baseMs: 40,
      maxThreshold: 120,
      maxRegressionPct: 25,
    });
    expect(withoutFactor.allowed).toBe(50);
    const zeroFactor = evaluateMeasurement({
      medianMs: 45,
      baseMs: 40,
      maxThreshold: 120,
      maxRegressionPct: 25,
      calibrationFactor: 0,
    });
    expect(zeroFactor.allowed).toBe(50);
  });

  it("meldet eine baseline ohne schwellen als fehler, statt still durchzulassen", () => {
    const result = evaluateMeasurement({ medianMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("keine Schwelle");
  });
});
