import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { scanGames } from "../../src/core/scan/games.js";
import { scanLocal } from "../../src/core/scan/local.js";
import { enrichProtondb } from "../../src/core/scan/protondb.js";
import { fakeSystem } from "../support/fakeSteam";
import { median } from "../support/median.js";
import {
  buildScanPerformanceFixture,
  createScanPerformanceCache,
  createScanPerformanceHttp,
  nodeFs,
  type ScanPerformanceScenario,
  warmScanPerformanceCache,
} from "../support/scanPerformance";

const MANUAL_RUNS = 5;
const CALIBRATION_RUNS = 20;
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
  output.push(
    `[scan benchmark] ${scenario}.${phase}Ms raw=${JSON.stringify(values)} ` +
      `median=${median(values)} max=${Math.max(...values)}`,
  );
}

/** Kalibrierung: eine feste, rein lokale Rechenlast im selben Prozess. Sie
 *  macht die Schwellen maschinenunabhängig, weil ein langsamerer Rechner auch
 *  einen größeren Kalibrierwert liefert. Gemessen: der CI-Runner ist rund
 *  dreimal langsamer als der Entwicklungsrechner. */
function measureCalibration(): number {
  const line = `\t"AppID_0123456789"\t\t"Fester Wert mit Text und Zahlen 42"\n`;
  const text = line.repeat(40000);
  const values: number[] = [];

  for (let run = 0; run < CALIBRATION_RUNS; run += 1) {
    const startedAt = performance.now();
    let tokens = 0;
    let inQuote = false;
    let seen = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === '"') {
        inQuote = !inQuote;
        continue;
      }
      if (!inQuote && (character === "\t" || character === "\n")) {
        if (seen > 0) {
          tokens += seen;
          seen = 0;
        }
        continue;
      }
      seen += 1;
    }
    tokens += seen;
    if (tokens === 0) throw new Error("Kalibrierung ohne Ergebnis");
    values.push(performance.now() - startedAt);
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
        () => "default",
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
  it("kalibriert die Maschine", () => {
    const value = measureCalibration();
    output.push(`[scan benchmark] calibrationMs raw=[] median=${value}`);
    expect(value).toBeGreaterThan(0);
  });

  it("cold cache, five paired runs", () => measureScenario("cold"));
  it("warm cache, five paired runs", () => measureScenario("warm"));
  it("offline, five paired runs", () => measureScenario("offline"));
});

afterAll(() =>
  writeFile(
    process.env.PROTIUM_BENCH_FILE ?? "/tmp/protium-scan-benchmark.txt",
    `${output.join("\n")}\n`,
    "utf8",
  ),
);
