// Gemeinsame Fixture-Fabriken der Tests: die Domänen-Objekte (Game,
// ScanResult, EnvironmentSnapshot, CompatTool, OrphanEntry, TrashEntry) haben
// viele Pflichtfelder; ohne Fabrik baut jede Testdatei dasselbe Literal neu
// und jede Vertragserweiterung muss überall nachgezogen werden. Die
// Dateibaum-/Port-Fakes bleiben in `fakeSteam.ts`; hier stehen nur die
// Objektformen. Ports-Importe fehlen bewusst, damit `vi.hoisted`-Blöcke diese
// Datei ohne Zyklen laden können.

import type { EnvironmentSnapshot } from "../../src/core/ports.js";
import type { TrashEntry } from "../../src/core/trash.js";
import type { CompatTool, Game, OrphanEntry, ScanResult } from "../../src/core/types.js";

/** Neutraler Testspieler: ein spiel in `/home/u/.steam`, ohne ProtonDB-Tier,
 *  ohne Startoptionen. Jede Abweichung kommt als Override. */
export function game(overrides: Partial<Game> = {}): Game {
  const appId = overrides.appId ?? 42;
  return {
    appId,
    name: `Game ${appId}`,
    library: "/home/u/.steam",
    sizeBytes: 100,
    compatTool: "default",
    compatToolSource: "default",
    protonDb: null,
    localHeader: null,
    headerImage: null,
    ...overrides,
  };
}

/** Scan-Ergebnis mit leerem Inventar. `games` ist der einzige Pflicht-Override
 *  in den meisten Tests, deshalb bleibt der Rest neutral. */
export function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    steamRoot: "/home/u/.steam",
    libraries: ["/home/u/.steam"],
    games: [],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: null,
    compatConfigStatus: "available",
    launchConfigStatus: "available",
    manifestCounts: { read: 0, failed: 0 },
    compatToolCounts: { read: 0, failed: 0 },
    steamUserId: null,
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
    blockedAppIds: [],
    ...overrides,
  };
}

/** Backend-Snapshot, wie ihn `discover_steam_environment` im Normalfall
 *  liefert: generation 1, eine library, die die wurzel enthält. */
export function environment(overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return {
    generation: 1,
    steamRoot: "/home/u/.steam",
    libraries: ["/home/u/.steam"],
    unavailableLibraries: [],
    systemCompatDirs: [],
    appCacheDir: "/home/u/.cache/protium",
    appConfigDir: "/home/u/.config/protium",
    ...overrides,
  };
}

export function customTool(name: string, overrides: Partial<CompatTool> = {}): CompatTool {
  return {
    name,
    internalName: name,
    displayName: name,
    sizeBytes: 100,
    usedBy: [],
    source: "user",
    ...overrides,
  };
}

export function orphan(
  appId: number,
  type: OrphanEntry["type"] = "compatdata",
  sizeBytes?: number,
): OrphanEntry {
  return {
    appId,
    type,
    path: `/home/u/.steam/steamapps/${type === "compatdata" ? "compatdata" : "shadercache"}/${appId}`,
    library: "/home/u/.steam",
    sizeBytes,
  };
}

/** Papierkorb-Eintrag mit dem namensschema
 *  `compatdata_<appId>_<unix-ms>`, das `readTrashEntries` erwartet. */
export function trashEntry(overrides: Partial<TrashEntry> = {}): TrashEntry {
  const appId = overrides.appId ?? 42;
  const trashedAt = overrides.trashedAt ?? 1_000;
  const type = overrides.type ?? "compatdata";
  return {
    appId,
    type,
    path: `/home/u/.steam/steamapps/.protium-trash/${type}_${appId}_${trashedAt}`,
    library: "/home/u/.steam",
    name: `${type}_${appId}_${trashedAt}`,
    trashedAt,
    ...overrides,
  };
}

/** Promise mit externem Auflöser: für Reihenfolge- und Rennen-Tests, in denen
 *  ein Aufruf erst nach einem anderen fertig werden darf. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** Ein Spiel mit belegter expliziter Zuordnung und ProtonDB-Tier: Ausgangspunkt
 *  der Support-Beleg-Tests in Core und UI. */
export function portal2(overrides: Partial<Game> = {}): Game {
  return game({
    appId: 620,
    name: "Portal 2",
    library: "/steam/library",
    compatTool: "proton_experimental",
    compatToolSource: "explicit",
    protonDb: { tier: "gold", confidence: "strong" },
    ...overrides,
  });
}
