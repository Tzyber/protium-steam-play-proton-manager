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

  it("meldet eine baseline ohne schwellen als fehler, statt still durchzulassen", () => {
    const result = evaluateMeasurement({ medianMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("keine Schwelle");
  });
});
