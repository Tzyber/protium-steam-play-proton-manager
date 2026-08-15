import { describe, expect, it } from "vitest";
import type { Http } from "../../../src/core/ports.js";
import { scanLocal } from "../../../src/core/scan/local.js";
import { enrichProtondb } from "../../../src/core/scan/protondb.js";
import { fakeSystem } from "../../support/fakeSteam";
import {
  buildScanPerformanceFixture,
  createScanPerformanceCache,
  nodeFs,
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
  it("erzeugt genau 500 spiele und 250 lokale header", async () => {
    const fixture = await buildScanPerformanceFixture();
    try {
      const local = await scanLocal(
        {
          fs: nodeFs(),
          system: fakeSystem(),
          http: immediateHttp(false).http,
          cache: createScanPerformanceCache().cache,
        },
        fixture.root,
        [],
      );

      expect(fixture.appIds).toHaveLength(500);
      expect(new Set(fixture.appIds)).toHaveLength(500);
      expect(fixture.headerAppIds).toHaveLength(250);
      expect(local.games).toHaveLength(500);
      expect(local.games.filter((game) => game.localHeader !== null)).toHaveLength(250);
      expect(local.warnings).toEqual([]);
      expect(local.skippedLibraries).toEqual([]);
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
      const local = await scanLocal(ports, fixture.root, []);
      await enrichProtondb(ports, local.games, 0);

      expect(countedHttp.calls).toHaveLength(0);
      expect(local.games).toHaveLength(500);
      expect(local.games.every((game) => game.protonDb?.tier === "gold")).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("degradiert offline alle 500 ProtonDB-Tiers zu unknown", async () => {
    const fixture = await buildScanPerformanceFixture();
    try {
      const countedHttp = immediateHttp(true);
      const ports = {
        fs: nodeFs(),
        system: fakeSystem(),
        http: countedHttp.http,
        cache: createScanPerformanceCache().cache,
      };
      const local = await scanLocal(ports, fixture.root, []);
      await enrichProtondb(ports, local.games, 0);

      expect(countedHttp.calls).toHaveLength(500);
      expect(local.games).toHaveLength(500);
      expect(local.games.every((game) => game.protonDb?.tier === "unknown")).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
