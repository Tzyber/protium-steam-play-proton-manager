import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSteamRoot } from "../../src/core/paths.js";
import { scanLibrary } from "../../src/core/scan.js";
import { buildFakeSteam, fakeHttp, fakeSystem, memCache, nodeFs } from "../support/fakeSteam";

describe("scanLibrary (integration — dominiks reales setup)", () => {
  it("dedupliziert libraries, findet system-compat-tools, erfüllt phase-1-akzeptanz", async () => {
    const { home, root, lib2, lib2Dup, staleLib, systemCompat, userId } = await buildFakeSteam();
    const fs = nodeFs();

    const discovered = await discoverSteamRoot(fs, home);
    expect(discovered).toBe(root);

    const system = fakeSystem();
    const result = await scanLibrary(
      { fs, http: fakeHttp(), system, cache: memCache() },
      { steamRoot: root, protonDbDelayMs: 0, extraCompatDirs: [systemCompat] },
    );

    // library-dedup: symlink-dup + staler eintrag raus, nur root + lib2 bleiben
    expect(result.libraries).toEqual([root, lib2]);
    expect(system.scopedPaths).toEqual(expect.arrayContaining([root, lib2]));
    expect(result.warnings.some((w) => w.includes(lib2Dup) && w.includes("identischer"))).toBe(
      true,
    );
    expect(
      result.warnings.some((w) => w.includes(staleLib) && w.includes("tote config-leiche")),
    ).toBe(true);

    // skippedLibraries: staleLib als path-missing klassifiziert, keine blocking-skips
    expect(result.skippedLibraries).toHaveLength(1);
    expect(result.skippedLibraries[0]).toEqual({ path: staleLib, reason: "path-missing" });

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
    // systemweites proton-cachyos-slr: usedBy NUR installierte echte spiele —
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

    // korruptes acf → warning, kein crash
    expect(result.warnings.some((w) => w.includes("appmanifest_9999"))).toBe(true);

    // installierte built-in protons (proton experimental) werden erfasst, obwohl sie aus games rausgefiltert sind
    expect(result.builtinProtonsInstalled).toEqual(
      expect.arrayContaining([
        { internalName: "proton_experimental", displayName: "Proton Experimental" },
      ]),
    );
    expect(result.games.some((g) => g.appId === 1493710)).toBe(false);
  });

  it("klassifiziert scope-failed wenn pfad existiert aber allowLibraryScope wirft", async () => {
    const { home, root, lib2 } = await buildFakeSteam();
    const fs = nodeFs();

    // extra library existiert, aber allowLibraryScope soll fehlschlagen
    const scopeFailLib = join(home, "scope-fail-lib/SteamLibrary");
    const scopeFailApps = join(scopeFailLib, "steamapps");
    await mkdir(scopeFailApps, { recursive: true });

    // libraryfolders.vdf um den extra pfad erweitern
    const lfPath = join(root, "steamapps/libraryfolders.vdf");
    const lfContent = await readFile(lfPath, "utf8");
    const idx = lfContent.lastIndexOf("}");
    const extra = `\t"99"\n\t{\n\t\t"path"\t\t"${scopeFailLib}"\n\t}\n`;
    const patched = `${lfContent.slice(0, idx)}${extra}${lfContent.slice(idx)}`;
    await writeFile(lfPath, patched, "utf8");

    const system = fakeSystem({ failScope: new Set([scopeFailLib]) });
    const result = await scanLibrary(
      { fs, http: fakeHttp(), system, cache: memCache() },
      { steamRoot: root, protonDbDelayMs: 0 },
    );

    expect(result.libraries).toEqual([root, lib2, scopeFailLib]);
    const scopeFailed = result.skippedLibraries.find((s) => s.path === scopeFailLib);
    expect(scopeFailed?.reason).toBe("scope-failed");
  });

  // der bericht (113:7): kein account durfte den scan nicht crashen, sondern
  // eine warnung zeigen, die erklärt, warum startoptionen fehlen.
  it("kein steam-account → warnung mit erklärung, scan läuft durch", async () => {
    const { home, root } = await buildFakeSteam();
    const fs = nodeFs();
    await rm(join(root, "userdata"), { recursive: true, force: true });

    const result = await scanLibrary(
      { fs, http: fakeHttp(), system: fakeSystem(), cache: memCache() },
      { steamRoot: root, protonDbDelayMs: 0 },
    );

    expect(result.warnings).toContain(
      "kein steam-account mit localconfig.vdf gefunden → startoptionen unbekannt",
    );
    expect(result.steamUserId).toBeNull();
    expect(result.games.length).toBeGreaterThan(0);
    expect(result.games.every((g) => g.launchOptions === undefined)).toBe(true);
  });
});
