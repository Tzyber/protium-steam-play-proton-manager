import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { CALIBRATION_NAME, formatMeasurementLine } from "../../scripts/bench-gate-lib.mjs";
import { scanGames } from "../../src/core/scan/games.js";
import { scanLocal } from "../../src/core/scan/local.js";
import { enrichProtondb } from "../../src/core/scan/protondb.js";
import { fakeSystem } from "../support/fakeSteam";
import { median } from "../support/median";
import {
  buildScanPerformanceFixture,
  createScanPerformanceCache,
  createScanPerformanceHttp,
  nodeFs,
  type ScanPerformanceScenario,
  warmScanPerformanceCache,
} from "../support/scanPerformance";

const MANUAL_RUNS = 5;
const CALIBRATION_RUNS = 5;
/** Zehntel des Haupt-Fixtures: dieselbe Arbeit, kurz genug fuer jeden Lauf. */
const CALIBRATION_GAME_COUNT = 50;
const output: string[] = [];

interface ScenarioMeasurements {
  localMs: number[];
  scanGamesMs: number[];
  protonDbMs: number[];
}

function printMeasurements(
  scenario: ScanPerformanceScenario,
  phase: "local" | "scanGames" | "protonDb",
  values: readonly number[],
): void {
  output.push(formatMeasurementLine(`${scenario}.${phase}`, values, median(values)));
}

/** Kalibrierung: dieselbe Arbeit wie im Scan (Manifeste von der Platte lesen
 *  und parsen) an einem kleinen Fixture, im selben Prozess. Sie macht die
 *  Schwellen maschinenunabhängig. Eine reine Rechenlast genügt dafür nicht:
 *  gemessen war der CI-Runner bei einer Zeichenschleife nur 1,4-fach langsamer,
 *  beim echten Scan aber 2,6-fach, weil dort Dateizugriffe und Allokationen
 *  dazukommen. */
async function measureCalibration(): Promise<number> {
  const values: number[] = [];

  for (let run = 0; run < CALIBRATION_RUNS; run += 1) {
    const fixture = await buildScanPerformanceFixture({ gameCount: CALIBRATION_GAME_COUNT });
    try {
      const startedAt = performance.now();
      const result = await scanGames(
        nodeFs(),
        fixture.root,
        [fixture.root],
        () => ({ compatTool: "default", compatToolSource: "default" }),
        fixture.localConfigText,
      );
      values.push(performance.now() - startedAt);
      if (result.games.length !== fixture.appIds.length) {
        throw new Error("Kalibrierung ohne vollstaendiges Ergebnis");
      }
    } finally {
      await fixture.cleanup();
    }
  }

  return median(values);
}

async function measureScenario(scenario: ScanPerformanceScenario): Promise<void> {
  const measurements: ScenarioMeasurements = { localMs: [], scanGamesMs: [], protonDbMs: [] };

  for (let run = 0; run < MANUAL_RUNS; run += 1) {
    const gamesFixture = await buildScanPerformanceFixture();
    try {
      const gamesFs = nodeFs();
      const gamesStartedAt = performance.now();
      const gamesResult = await scanGames(
        gamesFs,
        gamesFixture.root,
        [gamesFixture.root],
        () => ({ compatTool: "default", compatToolSource: "default" }),
        gamesFixture.localConfigText,
      );
      measurements.scanGamesMs.push(performance.now() - gamesStartedAt);

      expect(gamesResult.games).toHaveLength(gamesFixture.appIds.length);
      expect(gamesResult.games.filter((game) => game.launchOptions !== undefined)).toHaveLength(
        gamesFixture.launchOptionAppIds.length,
      );
      expect(gamesResult.localConfigDegraded).toBeNull();
      expect(gamesResult.games.filter((game) => game.localHeader !== null)).toHaveLength(
        gamesFixture.headerAppIds.length,
      );
      expect(gamesResult.blockedAppIds).toHaveLength(0);
      expect(gamesResult.warnings).toEqual([]);
      expect(gamesResult.skippedLibraries).toEqual([]);
      expect(gamesResult.cleanupUnsafeLibraries).toEqual([]);
    } finally {
      await gamesFixture.cleanup();
    }

    const fixture = await buildScanPerformanceFixture();
    try {
      const fs = nodeFs();
      const system = fakeSystem();
      const countedHttp = createScanPerformanceHttp(scenario);
      const memoryCache = createScanPerformanceCache();
      if (scenario === "warm") {
        await warmScanPerformanceCache(memoryCache.cache, fixture.appIds);
      }
      const ports = {
        fs,
        system,
        http: countedHttp.http,
        cache: memoryCache.cache,
      };

      const localStartedAt = performance.now();
      const local = await scanLocal(ports, fixture.environment);
      measurements.localMs.push(performance.now() - localStartedAt);

      expect(local.games).toHaveLength(fixture.appIds.length);
      expect(local.games.every((game) => game.protonDb === null)).toBe(true);
      expect(local.games.filter((game) => game.localHeader !== null)).toHaveLength(
        fixture.headerAppIds.length,
      );
      expect(local.warnings).toEqual([]);
      expect(local.skippedLibraries).toEqual([]);
      expect(local.cleanupUnsafeLibraries).toEqual([]);

      const protonDbStartedAt = performance.now();
      await enrichProtondb(ports, local.games, 0);
      measurements.protonDbMs.push(performance.now() - protonDbStartedAt);

      const expectedTier = scenario === "offline" ? "unknown" : "gold";
      expect(local.games.every((game) => game.protonDb?.tier === expectedTier)).toBe(true);
      expect(countedHttp.urls).toHaveLength(scenario === "warm" ? 0 : fixture.appIds.length);
      expect(new Set(countedHttp.urls)).toHaveLength(countedHttp.urls.length);
    } finally {
      await fixture.cleanup();
    }
  }

  printMeasurements(scenario, "local", measurements.localMs);
  printMeasurements(scenario, "scanGames", measurements.scanGamesMs);
  printMeasurements(scenario, "protonDb", measurements.protonDbMs);
}

describe("scan performance fixture", () => {
  it("kalibriert die Maschine", async () => {
    const value = await measureCalibration();
    output.push(formatMeasurementLine(CALIBRATION_NAME, [], value));
    expect(value).toBeGreaterThan(0);
  });

  it("kalter cache, fünf gepaarte läufe", () => measureScenario("cold"));
  it("warmer cache, fünf gepaarte läufe", () => measureScenario("warm"));
  it("offline, fünf gepaarte läufe", () => measureScenario("offline"));
});

afterAll(() =>
  writeFile(
    process.env.PROTIUM_BENCH_FILE ?? join(tmpdir(), "protium-scan-benchmark.txt"),
    `${output.join("\n")}\n`,
    "utf8",
  ),
);
