// biome-ignore assist/source/organizeImports: mock-registrierung muss vor dem store-import laufen (T-01)
import {
  addDirEntry,
  failVfsPath,
  fakeScan,
  fakeTrashEntry,
  mockBatchDirSizes,
  mockIsSteamRunning,
  mockListTrashEntries,
  mockPrepareDelete,
  mockReadDir,
  mockReadTextFile,
  resetCleanupMocks,
  seedShortcutIds,
  seedTrashEntries,
  setClaimDir,
  setOrphanDirs,
  setTextFile,
  STEAM_ROOT,
} from "../support/cleanupStoreMocks";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE_CLAIM_PREFIX } from "../../src/core/cleanup";
import { paths } from "../../src/core/paths";
import type { ScanResult } from "../../src/core/types";
import * as vdfRead from "../../src/core/vdfRead";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { deferred } from "../support/factories";

describe("cleanupStore scan, gates & cache", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
  });

  it("blockiert bei scope-failed, read-failed, unverified und cleanupUnsafeLibraries", async () => {
    const scanStore = useScanStore();
    const store = useCleanupStore();

    for (const reason of ["scope-failed", "read-failed", "unverified"] as const) {
      scanStore.result = fakeScan([{ path: "/ext/lib", reason }]);
      await store.scanOrphans();
      expect(store.blockedBySkipped).toBe(true);
      expect(store.error).toContain("/ext/lib");
      expect(store.orphans).toEqual([]);
    }

    scanStore.result = fakeScan([], ["/unsafe/lib"]);
    await store.scanOrphans();
    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/unsafe/lib");
    await store.deleteOrphans([
      { appId: 1, type: "compatdata", path: "/fake", library: STEAM_ROOT },
    ]);
    expect(mockPrepareDelete).not.toHaveBeenCalled();
  });

  it("sperrt bei path-missing nach ignorieren nicht; scope-failed verdrängt path-missing", async () => {
    const scanStore = useScanStore();
    const store = useCleanupStore();

    scanStore.result = fakeScan([
      { path: "/gone/lib", reason: "path-missing" },
      { path: "/ext/lib", reason: "scope-failed" },
    ]);
    await store.scanOrphans();
    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/ext/lib");
    expect(store.error).not.toContain("/gone/lib");
    expect(store.pathMissingLibs).toEqual([]);

    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    await store.scanOrphans();
    expect(store.blockedBySkipped).toBe(false);
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);
    expect(store.error).toBeNull();

    await store.dismissPathMissing();
    expect(store.pathMissingLibs).toEqual([]);
    expect(store.orphanDeleteBlocked("compatdata")).toBe(false);

    await store.deleteOrphans([
      {
        appId: 999999,
        type: "compatdata",
        path: "/lib/steamapps/compatdata/999999",
        library: STEAM_ROOT,
      },
    ]);
    expect(mockPrepareDelete).toHaveBeenCalledTimes(1);
  });

  it("persistiert ignorierte pfade über pinia-neustart und fragt bei neuem toten pfad erneut", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();
    await store.scanOrphans();
    await store.dismissPathMissing();

    setActivePinia(createPinia());
    const scanStore2 = useScanStore();
    scanStore2.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store2 = useCleanupStore();
    await store2.scanOrphans();
    expect(store2.pathMissingLibs).toEqual([]);
    expect(store2.ignoredMissingLibs).toEqual(["/gone/lib"]);

    scanStore2.result = fakeScan([
      { path: "/gone/lib", reason: "path-missing" },
      { path: "/neu/weg", reason: "path-missing" },
    ]);
    await store2.scanOrphans();
    expect(store2.pathMissingLibs).toEqual(["/neu/weg"]);

    await store2.unignoreMissingLibs();
    expect(store2.ignoredMissingLibs).toEqual([]);
    expect(store2.pathMissingLibs).toEqual(["/gone/lib", "/neu/weg"]);
  });

  it("fail-closed bei verletztem scan-vertrag (F1/N5a)", async () => {
    const scanStore = useScanStore();
    const bad = fakeScan();
    Reflect.deleteProperty(bad, "cleanupUnsafeLibraries");
    scanStore.result = bad as ScanResult;
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("Sicherheitsfeld");

    await store.deleteOrphans([
      { appId: 1091500, type: "compatdata", path: "/fake", library: STEAM_ROOT },
    ]);
    expect(mockPrepareDelete).not.toHaveBeenCalled();
  });

  it("verwendet während laufendem library-rescan keinen alten snapshot", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    scanStore.status = "scanning";
    const store = useCleanupStore();
    store.orphans = [{ appId: 1, type: "shadercache", path: "/old/1", library: "/old" }];
    store.trash = [fakeTrashEntry()];

    await store.scanOrphans();
    await store.scanTrash();

    expect(store.orphans).toEqual([]);
    expect(store.trash).toEqual([]);
  });

  it("bewahrt getrennte orphan- und trash-fehler und bricht bei steam-check-unavailable ab (P8)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();

    mockIsSteamRunning.mockRejectedValueOnce(new Error("steam-check-unavailable: /proc"));
    await expect(store.scanOrphans()).resolves.toBeUndefined();
    expect(store.orphanError).toBe(t("errors.codes.steamCheckUnavailable"));
    expect(store._orphanScanError).toBe(t("errors.codes.steamCheckUnavailable"));
    expect(store.scanning).toBe(false);

    seedTrashEntries([], { error: new Error("unreadable") });
    await store.scanTrash();
    expect(store.error).toContain("Steam-Status");
    expect(store.error).toContain("papierkorb");
  });

  it("sucht claims auch vor blockierendem gate und bei laufendem steam (inkl. unlesbare parents)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "read-failed" }]);
    const store = useCleanupStore();
    setClaimDir(paths.compatdataDir(STEAM_ROOT), `${DELETE_CLAIM_PREFIX}123`);

    await store.scanOrphans();
    expect(store.incompleteDeletions).toHaveLength(1);
    expect(store.incompleteDeletions[0]?.type).toBe("compatdata");
    expect(store.blockedBySkipped).toBe(true);

    resetCleanupMocks();
    scanStore.result = fakeScan();
    mockIsSteamRunning.mockResolvedValue(true);
    failVfsPath(paths.trashDir(STEAM_ROOT), new Error("EACCES: denied"));
    await store.scanOrphans();
    expect(store.incompleteDeletionsUnreadable).toEqual([paths.trashDir(STEAM_ROOT)]);
    expect(store.error).toContain("steam läuft");
  });

  it("markiert shortcut-bereich-orphans und behandelt unlesbare shortcuts fail-closed", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();

    setOrphanDirs([
      { appId: 3641016077, type: "compatdata" },
      { appId: 888888, type: "shadercache" },
    ]);
    await store.scanOrphans();
    const shortcutOrphan = store.orphans.find((o) => o.appId === 3641016077);
    expect(shortcutOrphan?.potentialShortcut).toBe(true);

    // korrupte shortcuts.vdf -> compatdata fail-closed weg, shadercache bleibt
    addDirEntry(paths.userdataDir(STEAM_ROOT), {
      name: "123",
      isDirectory: true,
      isSymlink: false,
    });
    addDirEntry(paths.userdataAccountDir(STEAM_ROOT, "123"), {
      name: "config",
      isDirectory: true,
      isSymlink: false,
    });
    failVfsPath(paths.shortcutsVdf(STEAM_ROOT, "123"), new Error("EACCES: permission denied"));

    await store.scanOrphans();
    expect(store.shortcutUnreadable).toBe(true);
    expect(store.prefixUnavailable).toBe(true);
    expect(store.trashUnavailable).toBe(false);
    expect(store.orphanDeleteBlocked("compatdata")).toBe(false);
    expect(store.coverageBlocked).toBe(true);
    expect(store.error).toContain("Wine-Prefix-Bereinigung deaktiviert");
    expect(store.orphans.every((o) => o.type === "shadercache")).toBe(true);

    // erkannte shortcut-appId wird bei deleteOrphans übersprungen
    resetCleanupMocks();
    seedShortcutIds([3641016077]);
    await store.deleteOrphans([
      { appId: 3641016077, type: "compatdata", path: "/fake/sc", library: STEAM_ROOT },
    ]);
    expect(store.error).toContain("inzwischen installiert");
  });

  it("trennt unlesbares compatdata/shadercache typ-genau und meldet M1-reihenfolge beim löschen", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    const compatDir = paths.compatdataDir(STEAM_ROOT);
    const shaderDir = paths.shadercacheDir(STEAM_ROOT);

    // 1. Aufruf kommt von findIncompleteDeletions ([] -> kein claim-parent-fehler),
    // ab dem 2. Aufruf (findOrphans) schlägt nur compatdata fehl -> typ-genaue Sperre.
    addDirEntry(compatDir, { name: "999999", isDirectory: true, isSymlink: false });
    mockReadDir.mockImplementationOnce(async () => []);
    mockReadDir.mockImplementation(async (p) => {
      if (p === compatDir) throw new Error("unreadable");
      return [];
    });
    await store.scanOrphans();
    expect(store.orphanError).toBeNull();
    expect(store.orphanUnreadable).toEqual([{ path: compatDir, type: "compatdata" }]);
    expect(store.prefixUnavailable).toBe(true);
    expect(store.shaderUnavailable).toBe(false);
    expect(store.orphanDeleteBlocked("compatdata")).toBe(true);
    expect(store.orphanDeleteBlocked("shadercache")).toBe(false);

    // M1: unlesbarer ort geht liegendem claim / scan-fehler vor
    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: `${compatDir}/999999`, library: STEAM_ROOT },
    ]);
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(store.orphanError).toBe(t("cleanup.unreadableDirs", { paths: compatDir }));

    // shadercache bleibt löschbar (auch wenn compatdata gesperrt ist)
    await store.deleteOrphans([
      { appId: 888888, type: "shadercache", path: `${shaderDir}/888888`, library: STEAM_ROOT },
    ]);
    expect(mockPrepareDelete).toHaveBeenCalledTimes(1);
    expect(store.orphanError).toBeNull();

    // Gegenrichtung + claim-titel
    resetCleanupMocks();
    setClaimDir(compatDir, `${DELETE_CLAIM_PREFIX}1`);
    await store.scanOrphans();
    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: `${compatDir}/999999`, library: STEAM_ROOT },
    ]);
    expect(store.orphanError).toBe(t("cleanup.incompleteDeletionsTitle"));

    // löschtext in orphanError darf typ-genaue anzeige nicht kippen (M2)
    expect(store.shaderUnavailable).toBe(false);
  });

  it("übernimmt steamOwnedPrefixes inkl. größen und leert stale status bei abbruch/leerscan", async () => {
    const scanStore = useScanStore();
    scanStore.result = { ...fakeScan(), blockedAppIds: [4628710] };
    setOrphanDirs([{ appId: 4628710, type: "compatdata" }]);
    const ownedPath = paths.compatdataPath(STEAM_ROOT, "4628710");
    mockBatchDirSizes.mockResolvedValueOnce({
      [ownedPath]: { status: "measured", sizeBytes: 8192 },
    });
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.steamOwnedPrefixes).toHaveLength(1);
    expect(store.steamOwnedPrefixes[0]?.sizeBytes).toBe(8192);

    scanStore.result = null;
    await store.scanTrash();
    expect(store.trash).toEqual([]);
    expect(store.error).toContain("scan-ergebnis");

    scanStore.result = fakeScan([{ path: "/broken", reason: "read-failed" }]);
    await store.scanOrphans();
    expect(store.steamOwnedPrefixes).toEqual([]);
    expect(store.orphans).toEqual([]);
    expect(store.blockedBySkipped).toBe(true);
  });

  it("verwirft stale orphan- und trash-scans sowie source-scan-race ohne gegenseitige invalidierung", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();

    const orphanGate = deferred<void>();
    setOrphanDirs([{ appId: 570, type: "compatdata" }]);
    const compatDir = paths.compatdataDir(STEAM_ROOT);
    let readCount = 0;
    mockReadDir.mockImplementation(async (dir) => {
      if (dir === compatDir) {
        readCount += 1;
        if (readCount === 1) await orphanGate.promise;
        return [{ name: String(readCount === 1 ? 570 : 730), isDirectory: true, isSymlink: false }];
      }
      return [];
    });

    const stale = store.scanOrphans();
    await vi.waitFor(() => expect(readCount).toBe(1));
    await store.scanOrphans();
    expect(store.orphans.map((o) => o.appId)).toEqual([730]);
    orphanGate.resolve();
    await stale;
    expect(store.orphans.map((o) => o.appId)).toEqual([730]);
    expect(store.scanning).toBe(false);

    // trash-scan invalidiert orphans nicht + source-scan-race verwirft ergebnis
    const trashGate = deferred<void>();
    mockListTrashEntries.mockImplementationOnce(async (lib) => {
      await trashGate.promise;
      return {
        dir: paths.trashDir(lib),
        present: true,
        entries: [{ name: "compatdata_570_1", isDirectory: true, isSymlink: false }],
      };
    });
    const racingTrash = store.scanTrash();
    await vi.waitFor(() => expect(mockListTrashEntries).toHaveBeenCalledTimes(1));
    scanStore.scanGeneration += 1;
    scanStore.status = "scanning";
    trashGate.resolve();
    await racingTrash;
    expect(store.trash).toEqual([]);
  });

  it("behandelt batchDirSizes missing/failed/unsafe-int atomar und ohne stilles 0", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    setOrphanDirs([
      { appId: 12345, type: "compatdata" },
      { appId: 12346, type: "compatdata" },
    ]);
    const p1 = paths.compatdataPath(STEAM_ROOT, "12345");
    const p2 = paths.compatdataPath(STEAM_ROOT, "12346");
    mockBatchDirSizes.mockResolvedValueOnce({
      [p1]: { status: "measured", sizeBytes: 8192 },
      [p2]: { status: "missing" },
    });
    const store = useCleanupStore();
    await store.scanOrphans();
    expect(store.orphans.find((o) => o.appId === 12345)?.sizeBytes).toBe(8192);
    expect(store.orphans.find((o) => o.appId === 12346)?.sizeBytes).toBeUndefined();

    // vertragsfehler: fehlender eintrag oder unsichere zahl verwirft ganze batch
    mockBatchDirSizes.mockResolvedValueOnce({
      [p1]: { status: "measured", sizeBytes: 8192 },
      [p2]: { status: "measured", sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
    });
    await store.scanOrphans();
    expect(store.error).toContain("ungültig");
    expect(store.orphans.map((o) => o.sizeBytes)).toEqual([undefined, undefined]);

    mockBatchDirSizes.mockResolvedValueOnce({
      [p1]: { status: "failed", detail: "EIO" },
      [p2]: { status: "failed", detail: "EIO" },
    });
    await store.scanOrphans();
    expect(store.error).toBeNull();
  });

  it("reichert orphan-namen für 50 orphans in einem VDF-tokenize-lauf an und ignoriert lesefehler (2.11)", async () => {
    const appBlocks = Array.from(
      { length: 50 },
      (_, i) =>
        `\t\t\t\t\t"${1000 + i}"\n\t\t\t\t\t{\n\t\t\t\t\t\t"name"\t\t"Game ${i}"\n\t\t\t\t\t}`,
    ).join("\n");
    setTextFile(
      paths.localConfigVdf(STEAM_ROOT, "12345"),
      `"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"Apps"\n\t\t\t\t{\n${appBlocks}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n`,
    );
    const spy = vi.spyOn(vdfRead, "getVdfChildFieldValues");
    const store = useCleanupStore();
    store.orphans = Array.from({ length: 50 }, (_, i) => ({
      appId: 1000 + i,
      type: "compatdata" as const,
      path: `${paths.compatdataDir(STEAM_ROOT)}/${1000 + i}`,
      library: STEAM_ROOT,
    }));

    const names = await store.readOrphanNames({ ...fakeScan(), steamUserId: "12345" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mockReadTextFile).toHaveBeenCalledTimes(1);
    expect(Object.keys(names)).toHaveLength(50);
    expect(names[`${paths.compatdataDir(STEAM_ROOT)}/1000`]).toBe("Game 0");
    spy.mockRestore();

    mockReadTextFile.mockRejectedValueOnce(new Error("EACCES"));
    expect(await store.readOrphanNames({ ...fakeScan(), steamUserId: "12345" })).toEqual({});
  });
});
