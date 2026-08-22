import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { scanLocal } from "../../../src/core/scan/local.js";
import { buildFakeSteam, fakeHttp, fakeSystem, memCache, nodeFs } from "../../support/fakeSteam";

describe("scanLocal", () => {
  it("führt lokale Phasen in einem Ergebnis zusammen und lässt ProtonDB unverändert", async () => {
    const { root, environment } = await buildFakeSteam();
    const result = await scanLocal(
      { fs: nodeFs(), http: fakeHttp(), system: fakeSystem(), cache: memCache() },
      environment,
    );

    expect(result.games.map((game) => game.appId).sort((a, b) => a - b)).toEqual([570, 620, 730]);
    expect(result.games.every((game) => game.protonDb === null)).toBe(true);
    expect(result.compatToolsInstalled).toHaveLength(3);
    expect(result.defaultCompatTool).toBe("proton-cachyos-slr");
    expect(result.warnings.some((warning) => warning.includes("appmanifest_9999.acf"))).toBe(true);
    expect(result.cleanupUnsafeLibraries).toContain(root);
  });

  it("aggregiert die lokale config-degradation ohne ProtonDB-phase", async () => {
    const { root, environment } = await buildFakeSteam();
    const configPath = `${root}/config/config.vdf`;
    await rm(configPath);

    const result = await scanLocal(
      { fs: nodeFs(), http: fakeHttp(), system: fakeSystem(), cache: memCache() },
      { ...environment, systemCompatDirs: [] },
    );

    expect(result.games).toHaveLength(3);
    expect(result.games.every((game) => game.compatTool === "unknown")).toBe(true);
    expect(result.compatToolsInstalled).toHaveLength(2);
    expect(result.defaultCompatTool).toBeNull();
    expect(result.warnings).toContain("config.vdf fehlt → compat-tools als 'unknown' markiert");
    expect(result.cleanupUnsafeLibraries).toContain(root);
  });
});
