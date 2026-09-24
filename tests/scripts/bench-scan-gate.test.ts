import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CALIBRATION_NAME, formatMeasurementLine } from "../../scripts/bench-gate-lib.mjs";

// T-06: das Parsing des Gates selbst (`scripts/bench-scan-gate.mjs`) war
// ungetestet; geprüft war nur `evaluateMeasurement` aus der Bibliothek. Der
// test fährt das skript deshalb als prozess mit `--skip-run` und einer
// vorbereiteten Ausgabedatei: genau der Weg, den `npm run bench:gate` nach dem
// benchmark nimmt.
const repo = resolve(import.meta.dirname, "../..");
const gate = join(repo, "scripts", "bench-scan-gate.mjs");
const baselineFile = join(repo, "tests", "benchmarks", "bench-baseline.json");

interface Baseline {
  scenarios: Record<string, Record<string, number>>;
  calibrationMs: number;
}

const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Baseline;

const phaseCount = Object.values(baseline.scenarios).reduce(
  (sum, phases) => sum + Object.keys(phases).length,
  0,
);

function runGate(lines: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "protium-bench-gate-"));
  const file = join(dir, "out.txt");
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  try {
    const result = spawnSync(process.execPath, [gate, "--skip-run"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PROTIUM_BENCH_FILE: file },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** messzeilen für alle in der baseline erwarteten punkte (`scenario.phase`),
 *  einzelne werte per namen überschreibbar: der test bleibt damit an die echte
 *  Baseline gebunden und bricht nicht, wenn dort ein punkt dazukommt. */
function measurementLines(overrides: Record<string, number> = {}): string[] {
  return Object.entries(baseline.scenarios).flatMap(([scenario, phases]) =>
    Object.entries(phases).map(([phase, median]) => {
      const name = `${scenario}.${phase}`;
      return formatMeasurementLine(name, [median], overrides[name] ?? median);
    }),
  );
}

function calibrationLine(value: number): string {
  return formatMeasurementLine(CALIBRATION_NAME, [], value);
}

function without(name: string): string[] {
  return measurementLines().filter((line) => !line.includes(` ${name}Ms`));
}

describe("bench-scan-gate", () => {
  it("akzeptiert die Baseline-werte als grünen Lauf", () => {
    const result = runGate([calibrationLine(baseline.calibrationMs), ...measurementLines()]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Alle ${phaseCount} Messpunkte erfuellen die Vorgaben.`);
    expect(result.status).toBe(0);
  });

  it("meldet fehlende messpunkte namentlich", () => {
    const result = runGate([calibrationLine(baseline.calibrationMs), ...without("warm.protonDb")]);

    expect(result.stderr).toContain("Messpunkte fehlen: warm.protonDb");
    expect(result.status).toBe(1);
  });

  it("ignoriert eine messzeile ohne phasentrenner", () => {
    const lines = [...without("warm.protonDb"), formatMeasurementLine("ohnePunkt", [1], 1)];
    const result = runGate([calibrationLine(baseline.calibrationMs), ...lines]);

    // ein name ohne "." trägt keine phase: er darf den erwarteten punkt nicht
    // still ersetzen.
    expect(result.stderr).toContain("Messpunkte fehlen: warm.protonDb");
    expect(result.status).toBe(1);
  });

  it("reisst bei einer überschrittenen schwelle", () => {
    const result = runGate([
      calibrationLine(baseline.calibrationMs),
      ...measurementLines({ "cold.local": 1000 }),
    ]);

    expect(result.stderr).toContain("FEHLER: cold.local");
    expect(result.stderr).toContain("[bench:gate] Performance-Gate fehlgeschlagen!");
    expect(result.status).toBe(1);
  });

  it("skaliert nur die cpu-gebundenen phasen mit dem kalibrierfaktor", () => {
    // faktor 2 (12.46 ms gegen 6.23 ms): 120 ms liegt über der unskalierten
    // Schwelle (56.25 ms) und unter der skalierten (126 ms).
    const scaled = runGate([
      calibrationLine(baseline.calibrationMs * 2),
      ...measurementLines({ "cold.local": 120 }),
    ]);
    expect(scaled.stdout).toContain("Faktor 2.00");
    expect(scaled.status).toBe(0);

    // ohne Kalibrierzeile bleibt der faktor 1: derselbe Messwert reisst.
    const unscaled = runGate(measurementLines({ "cold.local": 120 }));
    expect(unscaled.stdout).toContain("Faktor 1.00");
    expect(unscaled.stderr).toContain("FEHLER: cold.local");
    expect(unscaled.status).toBe(1);
  });

  it("skaliert die latenzgebundene protonDb-phase nicht", () => {
    // 4000 ms liegt über der unskalierten Obergrenze (3500 ms). Wäre die Phase
    // mitskaliert (Faktor 2), bliebe sie still grün.
    const result = runGate([
      calibrationLine(baseline.calibrationMs * 2),
      ...measurementLines({ "cold.protonDb": 4000 }),
    ]);

    expect(result.stderr).toContain("cold.protonDb");
    expect(result.status).toBe(1);
  });
});
