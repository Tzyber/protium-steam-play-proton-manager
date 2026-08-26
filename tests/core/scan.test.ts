import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanLibrary } from "../../src/core/scan.js";
import { buildFakeSteam, fakeHttp, fakeSystem, memCache, nodeFs } from "../support/fakeSteam";

describe("scanLibrary (integration, dominiks reales setup)", () => {
  it("bricht ohne aktuellen Environment-Root fail-closed ab", async () => {
    await expect(
      scanLibrary(
        { fs: nodeFs(), http: fakeHttp(), system: fakeSystem(), cache: memCache() },
        {
          environment: {
            generation: 0,
            steamRoot: "/tmp/claimed",
            libraries: [],
            systemCompatDirs: [],
            appCacheDir: "/tmp/cache",
            appConfigDir: "/tmp/config",
          },
        },
      ),
    ).rejects.toThrow("environment snapshot");
  });

  it("dedupliziert libraries, findet system-compat-tools, erfüllt phase-1-akzeptanz", async () => {
    const { root, lib2, lib2Dup, staleLib, systemCompat, userId, environment } =
      await buildFakeSteam();
    const fs = nodeFs();

    const system = fakeSystem();
    const result = await scanLibrary(
      { fs, http: fakeHttp(), system, cache: memCache() },
      { environment: { ...environment, systemCompatDirs: [systemCompat] }, protonDbDelayMs: 0 },
    );

    // library-dedup: symlink-dup + staler eintrag raus, nur root + lib2 bleiben
    expect(result.libraries).toEqual([root, lib2]);
    expect(result.warnings.some((w) => w.type === "manifest" && w.detail?.includes(lib2Dup))).toBe(
      false,
    );
    expect(result.warnings.some((w) => w.detail?.includes(staleLib))).toBe(false);
    expect(result.skippedLibraries).toHaveLength(0);

    const byId = new Map(result.games.map((g) => [g.appId, g]));

    // gefiltert / korrupt nicht enthalten, spiele NICHT dupliziert (dedup wirkt)
    expect(byId.has(1493710)).toBe(false);
    expect(byId.has(9999)).toBe(false);
    expect(result.games.filter((g) => g.appId === 730)).toHaveLength(1);
    expect([...byId.keys()].sort((a, b) => a - b)).toEqual([570, 620, 730]);

    // mappings: 620 → GE, 730 → cachyos-slr (interner name), 570 → default
    expect(byId.get(620)?.compatTool).toBe("GE-Proton9-27");
    expect(byId.get(730)?.compatTool).toBe("proton-cachyos-slr");
    expect(byId.get(570)?.compatTool).toBe("default");
    expect(byId.get(620)?.library).toBe(lib2);
    expect(byId.get(570)?.headerImage).toContain("/steam/apps/570/header.jpg");
    expect(byId.get(570)?.protonDb).toEqual({ tier: "unknown", confidence: "unknown" });

    // lokales cover: 620 hat eins im librarycache (hash-unterordner), 570 nicht
    expect(byId.get(620)?.localHeader).toContain("librarycache/620/abc123hash/library_header.jpg");
    expect(byId.get(570)?.localHeader).toBeNull();

    // compat-tools aus BEIDEN quellen (root + system)
    expect(result.compatToolsInstalled).toHaveLength(3);
    const ge = result.compatToolsInstalled.find((t) => t.name === "GE-Proton9-27");
    const cachyLocal = result.compatToolsInstalled.find((t) => t.name === "Proton-CachyOS Latest");
    const cachySystem = result.compatToolsInstalled.find((t) => t.name === "proton-cachyos-slr");

    expect(ge?.usedBy).toEqual([620]);
    // lokales "Proton-CachyOS Latest" (interner name == dir) wird von keinem spiel genutzt
    expect(cachyLocal?.internalName).toBe("Proton-CachyOS Latest");
    expect(cachyLocal?.usedBy).toEqual([]);
    // systemweites proton-cachyos-slr: usedBy NUR installierte echte spiele
    // appId 0 (default), 999999 (deinstalliert), 2207218128 (shortcut) fallen raus.
    expect(cachySystem?.internalName).toBe("proton-cachyos-slr");
    expect(cachySystem?.displayName).toContain("steam linux runtime");
    expect(cachySystem?.usedBy).toEqual([730]);
    // source: GE + lokales cachy aus user-dir, slr aus system-dir (→ read-only in UI)
    expect(ge?.source).toBe("user");
    expect(cachyLocal?.source).toBe("user");
    expect(cachySystem?.source).toBe("system");

    // globaler default (CompatToolMapping[0]) separat ausgewiesen, nicht in usedBy
    expect(result.defaultCompatTool).toBe("proton-cachyos-slr");

    // startoptionen aus localconfig.vdf des aktiven accounts (620 hat welche, rest nicht)
    expect(result.steamUserId).toBe(userId);
    expect(byId.get(620)?.launchOptions).toBe("gamemoderun %command%");
    expect(byId.get(570)?.launchOptions).toBeUndefined();

    // korruptes acf → warning, kein crash, library als unsafe markiert
    expect(
      result.warnings.some(
        (w) => w.type === "manifest" && w.manifestName === "appmanifest_9999.acf",
      ),
    ).toBe(true);
    expect(result.cleanupUnsafeLibraries).toContain(root);
    expect(result.cleanupUnsafeLibraries).not.toContain(lib2);

    // installierte built-in protons (proton experimental) werden erfasst, obwohl sie aus games rausgefiltert sind
    expect(result.builtinProtonsInstalled).toEqual(
      expect.arrayContaining([
        { internalName: "proton_experimental", displayName: "Proton Experimental" },
      ]),
    );
    expect(result.games.some((g) => g.appId === 1493710)).toBe(false);
  });

  it("scannt ausschließlich libraries aus dem aktuellen Environment-Snapshot", async () => {
    const { root, lib2, environment } = await buildFakeSteam();
    const fs = nodeFs();
    const claimed = join(root, "claimed-not-in-snapshot");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(claimed, "steamapps"), { recursive: true }),
    );
    const system = fakeSystem();
    const result = await scanLibrary(
      { fs, http: fakeHttp(), system, cache: memCache() },
      { environment: { ...environment, libraries: [root, lib2] }, protonDbDelayMs: 0 },
    );

    expect(result.libraries).toEqual([root, lib2]);
    expect(result.games.every((game) => game.library !== claimed)).toBe(true);
  });

  // der bericht (113:7): kein account durfte den scan nicht crashen, sondern
  // eine warnung zeigen, die erklärt, warum startoptionen fehlen.
  it("kein steam-account → warnung mit erklärung, scan läuft durch", async () => {
    const { root, environment } = await buildFakeSteam();
    const fs = nodeFs();
    await rm(join(root, "userdata"), { recursive: true, force: true });

    const result = await scanLibrary(
      { fs, http: fakeHttp(), system: fakeSystem(), cache: memCache() },
      { environment, protonDbDelayMs: 0 },
    );

    expect(result.warnings).toContainEqual({
      type: "launch-config",
      reason: "missing",
      detail: "kein steam-account mit localconfig.vdf gefunden → startoptionen unbekannt",
    });
    expect(result.steamUserId).toBeNull();
    expect(result.games.length).toBeGreaterThan(0);
    expect(result.games.every((g) => g.launchOptions === undefined)).toBe(true);
  });

  it("fehlende config.vdf lässt spiele und tools sichtbar, aber compat-tools unbekannt", async () => {
    const { root, environment } = await buildFakeSteam();
    const fs = nodeFs();
    await rm(join(root, "config", "config.vdf"));

    const result = await scanLibrary(
      { fs, http: fakeHttp(), system: fakeSystem(), cache: memCache() },
      { environment: { ...environment, systemCompatDirs: [] }, protonDbDelayMs: 0 },
    );

    expect(result.games).toHaveLength(3);
    expect(result.games.every((game) => game.compatTool === "unknown")).toBe(true);
    expect(result.compatToolsInstalled).toHaveLength(2);
    expect(result.defaultCompatTool).toBeNull();
    expect(result.warnings).toContainEqual({
      type: "compat-config",
      reason: "missing",
      detail: "config.vdf fehlt → compat-tools als 'unknown' markiert",
    });
  });
});
