import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    expect(result.compatConfigStatus).toBe("available");
    expect(result.games.find((game) => game.appId === 620)?.compatToolSource).toBe("explicit");
    expect(result.games.find((game) => game.appId === 730)?.compatToolSource).toBe("explicit");
    expect(result.games.find((game) => game.appId === 570)?.compatToolSource).toBe("default");
    expect(result.compatToolsInstalled).toHaveLength(3);
    expect(result.defaultCompatTool).toBe("proton-cachyos-slr");
    expect(
      result.warnings.some(
        (warning) => warning.type === "manifest" && warning.manifestName === "appmanifest_9999.acf",
      ),
    ).toBe(true);
    expect(result.manifestCounts).toEqual({ read: 4, failed: 1 });
    expect(result.compatToolCounts).toEqual({ read: 3, failed: 0 });
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
    expect(result.compatConfigStatus).toBe("missing");
    expect(result.games.every((game) => game.compatToolSource === "unavailable")).toBe(true);
    expect(result.compatToolsInstalled).toHaveLength(2);
    expect(result.defaultCompatTool).toBeNull();
    expect(result.warnings).toContainEqual({
      type: "compat-config",
      reason: "missing",
      detail: "config.vdf fehlt → compat-tools als 'unknown' markiert",
    });
    expect(result.cleanupUnsafeLibraries).toContain(root);
  });

  it("unterscheidet fehlende default-zuordnung von einer verfügbaren config", async () => {
    const { root, environment } = await buildFakeSteam();
    await rm(join(root, "config", "config.vdf"));
    await writeFile(
      join(root, "config", "config.vdf"),
      '"InstallConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"CompatToolMapping"\n\t\t\t\t{\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n',
    );

    const result = await scanLocal(
      { fs: nodeFs(), http: fakeHttp(), system: fakeSystem(), cache: memCache() },
      { ...environment, systemCompatDirs: [] },
    );

    expect(result.compatConfigStatus).toBe("available");
    expect(result.defaultCompatTool).toBeNull();
    expect(result.games.every((game) => game.compatTool === "default")).toBe(true);
    expect(result.games.every((game) => game.compatToolSource === "unavailable")).toBe(true);
  });

  it("markiert eine unlesbare compat-config an jedem spiel als unavailable", async () => {
    const { root, environment } = await buildFakeSteam();
    await writeFile(join(root, "config", "config.vdf"), '"InstallConfigStore" { kaputt');

    const result = await scanLocal(
      { fs: nodeFs(), http: fakeHttp(), system: fakeSystem(), cache: memCache() },
      { ...environment, systemCompatDirs: [] },
    );

    expect(result.compatConfigStatus).toBe("unreadable");
    expect(result.games.every((game) => game.compatTool === "unknown")).toBe(true);
    expect(result.games.every((game) => game.compatToolSource === "unavailable")).toBe(true);
  });

  it("behandelt reservierte mappingwerte als echte explizite werte", async () => {
    const { root, environment } = await buildFakeSteam();
    const configPath = join(root, "config", "config.vdf");
    const config = await readFile(configPath, "utf8");
    const reserved = config
      .replace(/("620"\s*\{\s*"name"\s*\s*")GE-Proton9-27/, "$1default")
      .replace(/("730"\s*\{\s*"name"\s*\s*")proton-cachyos-slr/, "$1unknown");
    await writeFile(configPath, reserved);

    const result = await scanLocal(
      { fs: nodeFs(), http: fakeHttp(), system: fakeSystem(), cache: memCache() },
      { ...environment, systemCompatDirs: [] },
    );

    expect(result.games.find((game) => game.appId === 620)).toEqual(
      expect.objectContaining({ compatTool: "default", compatToolSource: "explicit" }),
    );
    expect(result.games.find((game) => game.appId === 730)).toEqual(
      expect.objectContaining({ compatTool: "unknown", compatToolSource: "explicit" }),
    );
  });
});
