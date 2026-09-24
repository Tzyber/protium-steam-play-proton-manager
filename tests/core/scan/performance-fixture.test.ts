import { describe, expect, it } from "vitest";
import type { Http } from "../../../src/core/ports.js";
import { scanLocal } from "../../../src/core/scan/local.js";
import { enrichProtondb } from "../../../src/core/scan/protondb.js";
import { fakeSystem } from "../../support/fakeSteam";
import {
  buildScanPerformanceFixture,
  createScanPerformanceCache,
  nodeFs,
  SCAN_FIXTURE_GAME_COUNT,
  SCAN_FIXTURE_HEADER_COUNT,
  warmScanPerformanceCache,
} from "../../support/scanPerformance";

function immediateHttp(offline: boolean): { http: Http; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    http: {
      async get(url: string) {
        calls.push(url);
        if (offline) throw new Error("fixture network offline");
        return {
          status: 200,
          ok: true,
          text: JSON.stringify({ tier: "gold", confidence: "strong" }),
          headers: {},
        };
      },
    },
  };
}

describe("scan performance fixture", () => {
  it(`erzeugt genau ${SCAN_FIXTURE_GAME_COUNT} spiele und ${SCAN_FIXTURE_HEADER_COUNT} lokale header`, async () => {
    const fixture = await buildScanPerformanceFixture();
    try {
      const local = await scanLocal(
        {
          fs: nodeFs(),
          system: fakeSystem(),
          http: immediateHttp(false).http,
          cache: createScanPerformanceCache().cache,
        },
        fixture.environment,
      );

      expect(fixture.appIds).toHaveLength(SCAN_FIXTURE_GAME_COUNT);
      expect(new Set(fixture.appIds)).toHaveLength(SCAN_FIXTURE_GAME_COUNT);
      expect(fixture.headerAppIds).toHaveLength(SCAN_FIXTURE_HEADER_COUNT);
      expect(local.games).toHaveLength(SCAN_FIXTURE_GAME_COUNT);
      expect(local.games.filter((game) => game.localHeader !== null)).toHaveLength(
        SCAN_FIXTURE_HEADER_COUNT,
      );
      expect(local.warnings).toEqual([]);
      expect(local.skippedLibraries).toEqual([]);
      expect(local.cleanupUnsafeLibraries).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("hält warmen cache ohne HTTP-Aufrufe", async () => {
    const fixture = await buildScanPerformanceFixture();
    try {
      const cache = createScanPerformanceCache();
      await warmScanPerformanceCache(cache.cache, fixture.appIds);
      const countedHttp = immediateHttp(false);
      const ports = {
        fs: nodeFs(),
        system: fakeSystem(),
        http: countedHttp.http,
        cache: cache.cache,
      };
      const local = await scanLocal(ports, fixture.environment);
      await enrichProtondb(ports, local.games, 0);

      expect(countedHttp.calls).toHaveLength(0);
      expect(local.games).toHaveLength(SCAN_FIXTURE_GAME_COUNT);
      expect(local.games.every((game) => game.protonDb?.tier === "gold")).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it(`degradiert offline alle ${SCAN_FIXTURE_GAME_COUNT} ProtonDB-Tiers zu unknown`, async () => {
    const fixture = await buildScanPerformanceFixture();
    try {
      const countedHttp = immediateHttp(true);
      const ports = {
        fs: nodeFs(),
        system: fakeSystem(),
        http: countedHttp.http,
        cache: createScanPerformanceCache().cache,
      };
      const local = await scanLocal(ports, fixture.environment);
      await enrichProtondb(ports, local.games, 0);

      expect(countedHttp.calls).toHaveLength(SCAN_FIXTURE_GAME_COUNT);
      expect(local.games).toHaveLength(SCAN_FIXTURE_GAME_COUNT);
      expect(local.games.every((game) => game.protonDb?.tier === "unknown")).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
