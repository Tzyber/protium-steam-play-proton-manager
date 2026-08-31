import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  findIncompleteDeletions,
  findOrphans,
  findSteamOwnedPrefixes,
} from "../../src/core/cleanup";
import type { DirectorySize, PendingDeleteInfo, PrepareDeleteRequest } from "../../src/core/ports";
import type { readAllShortcutAppIds } from "../../src/core/shortcuts";
import type { findTrashEntries, TrashEntry } from "../../src/core/trash";
import type { ScanResult } from "../../src/core/types";
import { formatBytes } from "../../src/ui/format";
import { setLocale } from "../../src/ui/i18n";

const {
  mockFindOrphans,
  mockFindIncompleteDeletions,
  mockFindSteamOwnedPrefixes,
  mockReadAllShortcutAppIds,
  mockFindTrashEntries,
  mockPrepareDelete,
  mockExecuteDelete,
  mockBatchDirSizes,
  mockReadLocalConfig,
  mockIsProcessRunning,
} = vi.hoisted(() => ({
  mockFindOrphans: vi.fn<typeof findOrphans>(async () => []),
  mockFindIncompleteDeletions: vi.fn<typeof findIncompleteDeletions>(async () => ({
    entries: [],
    unreadable: [],
  })),
  mockFindSteamOwnedPrefixes: vi.fn<typeof findSteamOwnedPrefixes>(async () => []),
  mockReadAllShortcutAppIds: vi.fn<typeof readAllShortcutAppIds>(async () => ({
    status: "none" as const,
  })),
  mockFindTrashEntries: vi.fn<typeof findTrashEntries>(async () => ({
    entries: [],
    unknown: [],
    unreadable: [],
    libraries: [],
  })),
  mockPrepareDelete: vi.fn<(req: PrepareDeleteRequest) => Promise<PendingDeleteInfo>>(
    async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [],
    }),
  ),
  mockExecuteDelete: vi.fn(async (_token: string) => ({
    success: true,
    deletedPath: "",
  })),
  mockBatchDirSizes: vi.fn<(paths: string[]) => Promise<Record<string, DirectorySize>>>(
    async (paths) =>
      Object.fromEntries(paths.map((path) => [path, { status: "missing" as const }])),
  ),
  mockReadLocalConfig: vi.fn(async () => ""),
  mockIsProcessRunning: vi.fn(async () => false),
}));

vi.mock("../../src/core/cleanup", () => ({
  findOrphans: mockFindOrphans,
  findIncompleteDeletions: mockFindIncompleteDeletions,
  findSteamOwnedPrefixes: mockFindSteamOwnedPrefixes,
}));
vi.mock("../../src/core/shortcuts", () => ({
  readAllShortcutAppIds: mockReadAllShortcutAppIds,
  SHORTCUT_ID_THRESHOLD: 2_147_483_648,
}));
vi.mock("../../src/core/trash", () => ({
  findTrashEntries: mockFindTrashEntries,
}));
vi.mock("../../src/core/adapters/tauri", async () => {
  // in-memory cache statt {}, der store persistiert die ignorier-entscheidung
  const cacheStore = new Map<string, string>();
  const tauriPorts = {
    fs: {
      readTextFile: mockReadLocalConfig,
    },
    http: {},
    system: {
      isProcessRunning: mockIsProcessRunning,
      batchDirSizes: mockBatchDirSizes,
      prepareDelete: mockPrepareDelete,
      executeDelete: mockExecuteDelete,
    },
    cache: {
      get: async (k: string) => cacheStore.get(k) ?? null,
      set: async (k: string, v: string) => {
        cacheStore.set(k, v);
      },
    },
  };
  return { tauriPorts };
});

import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useProtonStore } from "../../src/ui/stores/protonStore";
import { useScanStore } from "../../src/ui/stores/scanStore";

beforeEach(() => {
  mockFindIncompleteDeletions.mockReset();
  mockFindIncompleteDeletions.mockResolvedValue({ entries: [], unreadable: [] });
  mockIsProcessRunning.mockReset();
  mockIsProcessRunning.mockResolvedValue(false);
});

function fakeScan(
  skipped?: ScanResult["skippedLibraries"],
  cleanupUnsafeLibraries?: string[],
): ScanResult {
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
    skippedLibraries: skipped ?? [],
    cleanupUnsafeLibraries: cleanupUnsafeLibraries ?? [],
    blockedAppIds: [],
  };
}

function fakeScanWithoutCleanupSafety(): ScanResult {
  const result = fakeScan();
  Reflect.deleteProperty(result, "cleanupUnsafeLibraries");
  return result;
}

function fakeScanWithGames(gameIds: number[]): ScanResult {
  return {
    ...fakeScan(),
    games: gameIds.map((appId) => ({
      appId,
      name: `Game ${appId}`,
      library: "/home/u/.steam",
      sizeBytes: 100,
      compatTool: "default",
      compatToolSource: "default",
      protonDb: null,
      localHeader: null,
      headerImage: null,
    })),
  };
}

describe("cleanupStore gate logic", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de"); // assertions matchen deutsche substrings
    mockFindOrphans.mockReset();
    mockFindIncompleteDeletions.mockReset();
    mockReadAllShortcutAppIds.mockReset();
    mockFindTrashEntries.mockReset();
    mockIsProcessRunning.mockReset();
    mockPrepareDelete.mockReset();
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [],
    }));
    mockExecuteDelete.mockReset();
    mockExecuteDelete.mockResolvedValue({ success: true, deletedPath: "" });
    mockBatchDirSizes.mockReset();
    mockBatchDirSizes.mockImplementation(async (paths) =>
      Object.fromEntries(paths.map((path) => [path, { status: "missing" as const }])),
    );
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
    mockIsProcessRunning.mockResolvedValue(false);
    mockFindTrashEntries.mockResolvedValue({
      entries: [],
      unknown: [],
      unreadable: [],
      libraries: [],
    });
  });

  it("blockiert wenn scope-failed library vorhanden", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "scope-failed" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/ext/lib");
    expect(store.orphans).toEqual([]);
  });

  it("blockiert wenn read-failed library vorhanden", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "read-failed" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/ext/lib");
    expect(store.orphans).toEqual([]);
  });

  it("bewahrt getrennte orphan- und trash-fehler beim jeweils anderen scan", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    mockFindOrphans.mockRejectedValue(new Error("orphan read failed"));

    await store.scanOrphans();
    expect(store.error).toContain("orphan read failed");

    mockFindTrashEntries.mockResolvedValue({
      entries: [],
      unknown: [],
      unreadable: ["/home/u/.steam"],
      libraries: [],
    });
    await store.scanTrash();

    expect(store.error).toContain("orphan read failed");
    expect(store.error).toContain("papierkorb");
  });

  it("verwendet während eines laufenden library-rescans keinen alten snapshot", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    scanStore.status = "scanning";
    const store = useCleanupStore();
    store.orphans = [{ appId: 1, type: "shadercache", path: "/old/shader/1", library: "/old" }];
    store.trash = [
      {
        appId: 2,
        type: "compatdata",
        path: "/old/trash/compatdata_2_1000",
        library: "/old",
        name: "compatdata_2_1000",
        trashedAt: 1000,
      },
    ];

    await store.scanOrphans();
    await store.scanTrash();

    expect(mockFindIncompleteDeletions).not.toHaveBeenCalled();
    expect(mockFindOrphans).not.toHaveBeenCalled();
    expect(mockFindTrashEntries).not.toHaveBeenCalled();
    expect(store.orphans).toEqual([]);
    expect(store.trash).toEqual([]);
  });

  it("blockiert wenn scope-failed UND path-missing libraries vorhanden", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([
      { path: "/gone/lib", reason: "path-missing" },
      { path: "/ext/lib", reason: "scope-failed" },
    ]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/ext/lib");
    expect(store.error).not.toContain("/gone/lib");
    expect(store.pathMissingLibs).toEqual([]);
  });

  it("blockiert NICHT wenn nur path-missing, zeigt stattdessen freigabe-abfrage", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(false);
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);
    expect(store.error).toBeNull();
  });

  it("meldet liegengebliebene claim-verzeichnisse als incompleteDeletions", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();

    mockFindIncompleteDeletions.mockResolvedValue({
      entries: [
        {
          path: "/home/u/.steam/steamapps/compatdata/.protium-delete-claim-123",
          library: "/home/u/.steam",
          type: "compatdata",
          name: ".protium-delete-claim-123",
        },
      ],
      unreadable: [],
    });

    await store.scanOrphans();

    expect(store.incompleteDeletions).toHaveLength(1);
    expect(store.incompleteDeletions[0]?.type).toBe("compatdata");
    expect(store.orphans).toEqual([]);
  });

  it("sucht claims vor einem blockierenden library-gate und lässt sie sichtbar", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "read-failed" }]);
    const store = useCleanupStore();
    mockFindIncompleteDeletions.mockResolvedValue({
      entries: [
        {
          path: "/home/u/.steam/steamapps/compatdata/.protium-delete-claim-123",
          library: "/home/u/.steam",
          type: "compatdata",
          name: ".protium-delete-claim-123",
        },
      ],
      unreadable: [],
    });

    await store.scanOrphans();

    expect(mockFindIncompleteDeletions).toHaveBeenCalledTimes(1);
    expect(store.incompleteDeletions).toHaveLength(1);
    expect(store.blockedBySkipped).toBe(true);
  });

  it("sucht claims auch bei laufendem steam und meldet claim-lesefehler sichtbar", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    mockIsProcessRunning.mockResolvedValue(true);
    mockFindIncompleteDeletions.mockResolvedValue({
      entries: [],
      unreadable: ["/home/u/.steam/steamapps/.protium-trash"],
    });

    await store.scanOrphans();

    expect(mockFindIncompleteDeletions).toHaveBeenCalledTimes(1);
    expect(store.incompleteDeletionsUnreadable).toEqual([
      "/home/u/.steam/steamapps/.protium-trash",
    ]);
    expect(store.error).toContain("steam läuft");
  });

  it("markiert shortcut-bereich-orphans (2^31..2^32-1) als potentialShortcut", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();

    mockFindOrphans.mockResolvedValue([
      {
        appId: 3641016077,
        type: "compatdata",
        path: "/home/u/.steam/steamapps/compatdata/3641016077",
        library: "/home/u/.steam",
      },
    ]);

    await store.scanOrphans();

    expect(store.orphans).toHaveLength(1);
    expect(store.orphans[0]?.potentialShortcut).toBe(true);
  });

  it("die ignorier-entscheidung überlebt einen erneuten scan (kein wiederkehrender dialog)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);

    await store.dismissPathMissing();
    expect(store.pathMissingLibs).toEqual([]);

    // ansichtswechsel: neuer store, gleicher cache
    setActivePinia(createPinia());
    const scanStore2 = useScanStore();
    scanStore2.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store2 = useCleanupStore();
    await store2.scanOrphans();

    expect(store2.pathMissingLibs).toEqual([]);
    expect(store2.ignoredMissingLibs).toEqual(["/gone/lib"]);
  });

  it("ein NEUER toter pfad fragt erneut, obwohl ein anderer ignoriert ist", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();
    await store.scanOrphans();
    await store.dismissPathMissing();

    scanStore.result = fakeScan([
      { path: "/gone/lib", reason: "path-missing" },
      { path: "/neu/weg", reason: "path-missing" },
    ]);
    await store.scanOrphans();

    // nur der unbeantwortete pfad, nicht der bereits ignorierte
    expect(store.pathMissingLibs).toEqual(["/neu/weg"]);
  });

  it("unignoreMissingLibs bringt die abfrage zurück", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();
    await store.scanOrphans();
    await store.dismissPathMissing();
    expect(store.pathMissingLibs).toEqual([]);

    await store.unignoreMissingLibs();

    expect(store.ignoredMissingLibs).toEqual([]);
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);
  });

  it("nach dismissPathMissing lauft scanOrphans durch und cleared pathMissingLibs", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);

    store.dismissPathMissing();
    await new Promise((r) => setTimeout(r, 0));

    expect(store.pathMissingLibs).toEqual([]);
    expect(store.scanning).toBe(false);
  });

  it("deleteOrphans blockiert wenn blockedBySkipped true", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "read-failed" }]);
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.blockedBySkipped).toBe(true);

    await store.deleteOrphans([{ appId: 1, type: "compatdata", path: "/fake", library: "/lib" }]);
    expect(store.deleting.size).toBe(0);
  });

  it("blockiert scanOrphans wenn cleanupUnsafeLibraries vorhanden sind", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([], ["/unsafe/lib"]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/unsafe/lib");
    expect(store.orphans).toEqual([]);
  });

  it("blockiert deleteOrphans wenn cleanupUnsafeLibraries vorhanden sind", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([], ["/unsafe/lib"]);
    const store = useCleanupStore();

    await store.deleteOrphans([{ appId: 1, type: "compatdata", path: "/fake", library: "/lib" }]);

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/unsafe/lib");
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
  });

  it("blockiert scanOrphans fail-closed wenn cleanupUnsafeLibraries fehlt", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanWithoutCleanupSafety();
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("cleanupUnsafeLibraries");
    expect(mockFindOrphans).not.toHaveBeenCalled();
  });

  it("blockiert deleteOrphans fail-closed wenn cleanupUnsafeLibraries fehlt", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanWithoutCleanupSafety();
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 2147483647, type: "compatdata", path: "/fake", library: "/lib" },
    ]);

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("cleanupUnsafeLibraries");
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
  });

  it("wenn keine skipped libraries → scan lauft normal durch", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(false);
    expect(store.pathMissingLibs).toEqual([]);
    expect(store.error).toBeNull();
  });
});

describe("cleanupStore, S-05 + shortcuts", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockFindOrphans.mockReset();
    mockReadAllShortcutAppIds.mockReset();
    mockPrepareDelete.mockReset();
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [],
    }));
    mockExecuteDelete.mockReset();
    mockExecuteDelete.mockResolvedValue({ success: true, deletedPath: "" });
    mockBatchDirSizes.mockReset();
    mockBatchDirSizes.mockImplementation(async (paths) =>
      Object.fromEntries(paths.map((path) => [path, { status: "missing" as const }])),
    );
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
  });

  it("S-05: deleteOrphans überspringt einträge deren appId inzwischen installiert ist", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanWithGames([42]); // game 42 is installed
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 42, type: "compatdata", path: "/fake/42", library: "/lib" },
    ]);

    expect(store.error).toContain("inzwischen installiert");
  });

  it("deleteOrphans überspringt shortcut-appId wenn vom parser erkannt", async () => {
    mockReadAllShortcutAppIds.mockResolvedValue({
      status: "ok",
      ids: new Set([3641016077]),
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 3641016077, type: "compatdata", path: "/fake/sc", library: "/lib" },
    ]);

    expect(store.error).toContain("inzwischen installiert");
  });

  it("deleteOrphans blockiert compatdata wenn shortcuts.vdf unreadable", async () => {
    mockReadAllShortcutAppIds.mockResolvedValue({
      status: "unreadable",
      paths: ["/home/u/.steam/userdata/123/config/shortcuts.vdf"],
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
      { appId: 888888, type: "shadercache", path: "/fake/shader", library: "/lib" },
    ]);

    expect(store.error).toContain("nicht lesbar"); // wine-prefix blocked
    expect(store.error).not.toContain("888888"); // shadercache NOT blocked
  });

  it("scanOrphans blockiert compatdata aber erlaubt shadercache bei unlesbarem userdata", async () => {
    mockReadAllShortcutAppIds.mockResolvedValue({
      status: "unreadable",
      paths: [],
      detail: "EACCES: permission denied",
    });
    mockFindOrphans.mockResolvedValue([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
      { appId: 888888, type: "shadercache", path: "/fake/shader", library: "/lib" },
    ]);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.shortcutUnreadable).toBe(true);
    expect(store.error).toContain("Wine-Prefix-Bereinigung deaktiviert");
    expect(store.orphans).toHaveLength(1);
    expect(store.orphans[0]).toMatchObject({ appId: 888888, type: "shadercache" });
  });

  it("Policy: unlesbares shortcuts.vdf → compatdata fail-closed, shadercache regenerierbar", async () => {
    mockReadAllShortcutAppIds.mockResolvedValue({
      status: "unreadable",
      paths: ["/home/u/.steam/userdata/123/config/shortcuts.vdf"],
    });
    mockFindOrphans.mockResolvedValue([
      { appId: 111111, type: "compatdata", path: "/lib/compatdata/111111", library: "/lib" },
      { appId: 222222, type: "shadercache", path: "/lib/shadercache/222222", library: "/lib" },
    ]);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.orphans).toHaveLength(1);
    expect(store.orphans.some((o) => o.type === "compatdata")).toBe(false);
    expect(store.orphans.some((o) => o.type === "shadercache")).toBe(true);
    expect(store.error).toMatch(/Wine-Prefix-Bereinigung deaktiviert/i);
  });

  it("deleteOrphans blockiert ohne scan-ergebnis (fail-closed)", async () => {
    const scanStore = useScanStore();
    scanStore.result = null;
    const store = useCleanupStore();

    await store.deleteOrphans([{ appId: 1, type: "compatdata", path: "/fake", library: "/lib" }]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(store.error).toContain("scan-ergebnis");
    expect(store.orphans).toEqual([]);
  });
});

describe("cleanupStore, gemeinsame confirm-reservierung", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockReadAllShortcutAppIds.mockReset();
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
    mockPrepareDelete.mockReset();
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [],
    }));
    mockExecuteDelete.mockReset();
    mockExecuteDelete.mockResolvedValue({ success: true, deletedPath: "" });
  });

  it("erzeugt keinen orphan-token bei belegter GE-reservierung", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const confirm = useConfirmStore();
    const reservation = confirm.reserve();
    if (reservation === null) throw new Error("confirm-reservierung fehlt");

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(store.deleting.size).toBe(0);
    expect(confirm.reserved).toBe(true);
    expect(confirm.release(reservation)).toBe(true);
  });

  it("erzeugt keinen trash-token bei belegter GE-reservierung", async () => {
    const store = useCleanupStore();
    const confirm = useConfirmStore();
    const reservation = confirm.reserve();
    if (reservation === null) throw new Error("confirm-reservierung fehlt");

    await store.deleteTrashEntries([fakeTrashEntry()]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(confirm.reserved).toBe(true);
    expect(confirm.release(reservation)).toBe(true);
  });

  it("blockiert cleanup während eine GE-vorbereitung offen ist", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const proton = useProtonStore();
    const cleanup = useCleanupStore();
    const confirm = useConfirmStore();
    const prepared = deferred<PendingDeleteInfo>();
    mockPrepareDelete.mockImplementationOnce(() => prepared.promise);

    const geRemove = proton.remove({
      name: "GE-Proton9-27",
      internalName: "GE-Proton9-27",
      displayName: "GE-Proton9-27",
      sizeBytes: 1000,
      source: "user",
      usedBy: [],
    });
    await vi.waitFor(() => expect(mockPrepareDelete).toHaveBeenCalledTimes(1));

    await cleanup.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);

    expect(mockPrepareDelete).toHaveBeenCalledTimes(1);
    expect(cleanup.deleting.size).toBe(0);
    expect(confirm.reserved).toBe(true);

    prepared.resolve({
      token: "ge-token",
      expiresAt: Date.now() + 60000,
      targetType: "compatTool",
      targetPath: "/root/compatibilitytools.d/GE-Proton9-27",
      consequences: [],
    });
    await geRemove;
    expect(confirm.pending).not.toBeNull();
    confirm.cancel();
    expect(confirm.reserved).toBe(false);
  });

  it("reserviert vor dem ersten orphan-prepare und räumt bei cancel auf", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const confirm = useConfirmStore();
    mockPrepareDelete.mockImplementation(async (req) => {
      expect(confirm.reserved).toBe(true);
      return {
        token: `token-${req.path}`,
        expiresAt: Date.now() + 60000,
        targetType: req.targetType,
        targetPath: req.path,
        consequences: [],
      };
    });

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);

    expect(confirm.pending).not.toBeNull();
    expect(store.deleting.size).toBe(1);
    confirm.cancel();
    expect(confirm.reserved).toBe(false);
    expect(store.deleting.size).toBe(0);
  });

  it("räumt orphan-zustand bei ask-ablehnung und reservierungsfreigabe auf", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const confirm = useConfirmStore();
    vi.spyOn(confirm, "ask").mockReturnValue(false);

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);

    expect(store.deleting.size).toBe(0);
    expect(confirm.reserved).toBe(false);
    expect(confirm.pending).toBeNull();
  });

  it("gibt die trash-reservierung bei ask-ablehnung frei", async () => {
    const store = useCleanupStore();
    const confirm = useConfirmStore();
    vi.spyOn(confirm, "ask").mockReturnValue(false);

    await store.deleteTrashEntries([fakeTrashEntry()]);

    expect(mockPrepareDelete).toHaveBeenCalledTimes(1);
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(confirm.reserved).toBe(false);
    expect(confirm.pending).toBeNull();
  });
});

// batch_dir_sizes-skip-semantik: ein von rust übersprungener pfad (NotFound-race)
// darf im store NICHT als sizeBytes=0 landen, sonst ist er im UI nicht von einem
// echten 0-byte-orphan (leeres verzeichnis) unterscheidbar. stattdessen bleibt
// sizeBytes undefined → CleanupView rendert "…" (≠ "-" für leer, ≠ "0 B").
describe("cleanupStore, batch_dir_sizes NotFound-Skip", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockFindOrphans.mockReset();
    mockReadAllShortcutAppIds.mockReset();
    mockPrepareDelete.mockReset();
    mockExecuteDelete.mockReset();
    mockBatchDirSizes.mockReset();
    mockBatchDirSizes.mockImplementation(async (paths) =>
      Object.fromEntries(paths.map((path) => [path, { status: "missing" as const }])),
    );
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
  });

  it("übersprungener pfad → sizeBytes undefined, vorhandener pfad → gemessene größe", async () => {
    mockFindOrphans.mockResolvedValue([
      { appId: 12345, type: "compatdata", path: "/lib/compatdata/12345", library: "/lib" },
      { appId: 99999, type: "compatdata", path: "/lib/compatdata/99999_gone", library: "/lib" },
    ]);
    mockBatchDirSizes.mockResolvedValue({
      "/lib/compatdata/12345": { status: "measured", sizeBytes: 8192 },
      "/lib/compatdata/99999_gone": { status: "missing" },
    });

    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    // wiring-assertion: der store hängt am system-port, nicht am rohen invoke
    expect(mockBatchDirSizes).toHaveBeenCalledWith([
      "/lib/compatdata/12345",
      "/lib/compatdata/99999_gone",
    ]);

    expect(store.orphans).toHaveLength(2);
    const real = store.orphans.find((o) => o.appId === 12345);
    const vanished = store.orphans.find((o) => o.appId === 99999);
    expect(real?.sizeBytes).toBe(8192);
    expect(vanished?.sizeBytes).toBeUndefined();
  });

  it("fehlender batch-map-eintrag ist ein vertragsfehler", async () => {
    mockFindOrphans.mockResolvedValue([
      { appId: 12345, type: "compatdata", path: "/lib/compatdata/12345", library: "/lib" },
    ]);
    mockBatchDirSizes.mockResolvedValue({});
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.error).toContain("batchDirSizes");
    expect(store.orphans[0]?.sizeBytes).toBeUndefined();
  });

  it("failed-status bleibt unbekannt und wird nicht als fehlerhafte nullsumme gespeichert", async () => {
    mockFindOrphans.mockResolvedValue([
      { appId: 12345, type: "compatdata", path: "/lib/compatdata/12345", library: "/lib" },
    ]);
    mockBatchDirSizes.mockResolvedValue({
      "/lib/compatdata/12345": { status: "failed", detail: "EIO" },
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.error).toBeNull();
    expect(store.orphans[0]?.sizeBytes).toBeUndefined();
  });

  it("unsicherer measured-wert ist ein vertragsfehler", async () => {
    mockFindOrphans.mockResolvedValue([
      { appId: 12345, type: "compatdata", path: "/lib/compatdata/12345", library: "/lib" },
    ]);
    mockBatchDirSizes.mockResolvedValue({
      "/lib/compatdata/12345": {
        status: "measured",
        sizeBytes: Number.MAX_SAFE_INTEGER + 1,
      },
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.error).toContain("ungültige größe");
    expect(store.orphans[0]?.sizeBytes).toBeUndefined();
  });

  it("übernimmt bei einem späteren vertragsfehler keinen früheren batch-messwert", async () => {
    mockFindOrphans.mockResolvedValue([
      { appId: 12345, type: "compatdata", path: "/lib/compatdata/12345", library: "/lib" },
      { appId: 12346, type: "compatdata", path: "/lib/compatdata/12346", library: "/lib" },
    ]);
    mockBatchDirSizes.mockResolvedValue({
      "/lib/compatdata/12345": { status: "measured", sizeBytes: 8192 },
      "/lib/compatdata/12346": {
        status: "measured",
        sizeBytes: Number.MAX_SAFE_INTEGER + 1,
      },
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.error).toContain("ungültige größe");
    expect(store.orphans.map((entry) => entry.sizeBytes)).toEqual([undefined, undefined]);
  });

  it("UI-ternary: undefined-sizeBytes rendert '…' (nicht '-', nicht die größe)", () => {
    // derselbe ausdruck wie in CleanupView.vue, als regressionstest, damit eine
    // zukünftige änderung an formatBytes oder dem ternären operator die
    // unterscheidung "verschwunden (…)" vs "leer (-)" nicht wieder verwischt.
    // WICHTIG: die echte formatBytes importieren, kein lokales duplikat, ein
    // duplikat bliebe grün, selbst wenn das original bricht.
    const renderSize = (sb?: number) => (sb != null ? formatBytes(sb) : "…");
    expect(renderSize(undefined)).toBe("…");
    expect(renderSize(0)).toBe("-"); // echtes leeres verzeichnis
    expect(renderSize(8192)).toBe(formatBytes(8192));
  });

  it("reichert orphan-namen aus steams localconfig an, fallback app-id", async () => {
    mockFindOrphans.mockResolvedValue([
      { appId: 12345, type: "compatdata", path: "/lib/compatdata/12345", library: "/lib" },
      { appId: 99999, type: "compatdata", path: "/lib/compatdata/99999", library: "/lib" },
    ]);
    mockReadLocalConfig.mockResolvedValue(
      '"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"Apps"\n\t\t\t\t{\n\t\t\t\t\t"12345"\n\t\t\t\t\t{\n\t\t\t\t\t\t"name"\t\t"Test Game"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n',
    );
    const scanStore = useScanStore();
    scanStore.result = { ...fakeScan([]), steamUserId: "123" };
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.orphanNames["/lib/compatdata/12345"]).toBe("Test Game");
    expect(store.orphanNames["/lib/compatdata/99999"]).toBeUndefined();
  });

  it("unlesbare localconfig → keine namen, kein crash", async () => {
    mockFindOrphans.mockResolvedValue([
      { appId: 12345, type: "compatdata", path: "/lib/compatdata/12345", library: "/lib" },
    ]);
    mockReadLocalConfig.mockRejectedValue(new Error("EACCES"));
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.orphanNames).toEqual({});
    expect(store.orphans).toHaveLength(1);
  });
});

describe("cleanupStore steamOwnedPrefixes", () => {
  beforeEach(() => {
    mockFindOrphans.mockResolvedValue([]);
    mockFindSteamOwnedPrefixes.mockResolvedValue([]);
  });

  it("übernimmt steam-eigene prefixes und hängt deren größen an", async () => {
    mockFindSteamOwnedPrefixes.mockResolvedValue([
      { appId: 4628710, path: "/lib/compatdata/4628710", library: "/lib" },
    ]);
    mockBatchDirSizes.mockResolvedValue({
      "/lib/compatdata/4628710": { status: "measured", sizeBytes: 8192 },
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.steamOwnedPrefixes).toHaveLength(1);
    expect(store.steamOwnedPrefixes[0]?.sizeBytes).toBe(8192);
    expect(mockBatchDirSizes).toHaveBeenCalledWith(["/lib/compatdata/4628710"]);
  });

  it("setzt die einträge beim nächsten scan zurück", async () => {
    mockFindSteamOwnedPrefixes.mockResolvedValue([
      { appId: 4628710, path: "/lib/compatdata/4628710", library: "/lib" },
    ]);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.steamOwnedPrefixes).toHaveLength(1);

    mockFindSteamOwnedPrefixes.mockResolvedValue([]);
    await store.scanOrphans();
    expect(store.steamOwnedPrefixes).toEqual([]);
  });
});

function fakeTrashEntry(overrides?: Partial<TrashEntry>): TrashEntry {
  return {
    path: "/lib/steamapps/.protium-trash/compatdata_1091500_1753372800123",
    library: "/lib",
    name: "compatdata_1091500_1753372800123",
    type: "compatdata",
    appId: 1091500,
    trashedAt: 1753372800123,
    ...overrides,
  };
}

describe("cleanupStore, trash", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockFindTrashEntries.mockReset();
    mockPrepareDelete.mockReset();
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [],
    }));
    mockExecuteDelete.mockReset();
    mockExecuteDelete.mockResolvedValue({ success: true, deletedPath: "" });
    mockBatchDirSizes.mockReset();
    mockBatchDirSizes.mockImplementation(async (paths) =>
      Object.fromEntries(paths.map((path) => [path, { status: "missing" as const }])),
    );
    mockFindTrashEntries.mockResolvedValue({
      entries: [],
      unknown: [],
      unreadable: [],
      libraries: [],
    });
  });

  it("scanTrash ohne scan-ergebnis → error gesetzt", async () => {
    const scanStore = useScanStore();
    scanStore.result = null;
    const store = useCleanupStore();

    await store.scanTrash();

    expect(store.error).toContain("scan-ergebnis");
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
  });

  it("scanTrash füllt trash inkl. größen", async () => {
    const entry = fakeTrashEntry();
    mockFindTrashEntries.mockResolvedValue({
      entries: [entry],
      unknown: [],
      unreadable: [],
      libraries: [],
    });
    mockBatchDirSizes.mockResolvedValue({
      [entry.path]: { status: "measured", sizeBytes: 8192 },
    });

    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanTrash();

    expect(store.trash).toHaveLength(1);
    expect(store.trash[0]?.appId).toBe(1091500);
    expect(store.trash[0]?.sizeBytes).toBe(8192);
    expect(store.trashUnknown).toEqual([]);
  });

  it("scanTrash meldet unlesbaren papierkorb statt ihn als leer auszugeben", async () => {
    mockFindTrashEntries.mockResolvedValue({
      entries: [],
      unknown: [],
      unreadable: ["/lib"],
      libraries: [
        {
          library: "/lib",
          dir: "/lib/steamapps/.protium-trash",
          present: true,
          count: 0,
          error: "EACCES: permission denied",
        },
      ],
    });

    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanTrash();

    // darf NICHT als "papierkorb ist leer" durchgehen
    expect(store.error).toBeTruthy();
    expect(store.trashLibraries[0]?.error).toContain("EACCES");
  });

  it("emptyTrash löscht alle einträge", async () => {
    const e1 = fakeTrashEntry();
    const e2 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
    });
    // direkt setzen statt über scanTrash
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [e1, e2];

    await store.emptyTrash();
    await useConfirmStore().confirm();

    expect(store.trash).toHaveLength(0);
    expect(mockPrepareDelete).toHaveBeenCalledTimes(2);
    expect(mockPrepareDelete).toHaveBeenCalledWith({
      targetType: "trash",
      path: e1.path,
      steamRoot: "/home/u/.steam",
    });
    expect(mockPrepareDelete).toHaveBeenCalledWith({
      targetType: "trash",
      path: e2.path,
      steamRoot: "/home/u/.steam",
    });
    expect(mockExecuteDelete).toHaveBeenCalledTimes(2);
  });

  it("deleteTrashEntries bündelt eine auswahl in einem dialog", async () => {
    const e1 = fakeTrashEntry();
    const e2 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [e1, e2];

    await store.deleteTrashEntries([e1, e2]);
    expect(useConfirmStore().pending?.title).toBe("papierkorb leeren?");
    await useConfirmStore().confirm();

    expect(mockPrepareDelete).toHaveBeenCalledTimes(2);
    expect(mockExecuteDelete).toHaveBeenCalledTimes(2);
    expect(store.trash).toHaveLength(0);
  });

  it("prepare-teilfehler zeigt erfolgreiche einträge und lässt fehlende unverändert", async () => {
    const e1 = fakeTrashEntry();
    const e2 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
    });
    mockPrepareDelete.mockImplementation(async (req) => {
      if (req.path === e2.path) throw new Error("not readable");
      return {
        token: `token-${req.path}`,
        expiresAt: Date.now() + 60000,
        targetType: req.targetType,
        targetPath: req.path,
        consequences: [],
      };
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [e1, e2];

    await store.deleteTrashEntries([e1, e2]);

    expect(store.error).toContain("compatdata_570_100");
    expect(store.error).toContain("not readable");
    expect(useConfirmStore().pending?.message).toContain(
      "nicht vorbereitete Einträge (1) bleiben unverändert.",
    );
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(1);
    expect(store.trash).toEqual([e2]);
  });

  it("ohne erfolgreiches prepare gibt es keinen dialog und kein execute", async () => {
    mockPrepareDelete.mockRejectedValue(new Error("prepare failed"));
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const e1 = fakeTrashEntry();

    await store.deleteTrashEntries([e1]);

    expect(store.error).toContain("prepare failed");
    expect(useConfirmStore().pending).toBeNull();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
  });

  it("emptyTrash delegiert mit einem trash-snapshot", async () => {
    const e1 = fakeTrashEntry();
    const e2 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [e1, e2];
    const deleteSpy = vi.spyOn(store, "deleteTrashEntries").mockResolvedValue();

    await store.emptyTrash();

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    const snapshot = deleteSpy.mock.calls[0]?.[0];
    expect(snapshot).toEqual([e1, e2]);
    expect(snapshot).not.toBe(store.trash);
  });

  it("emptyTrash mit fehlschlag in der mitte, rest wird trotzdem gelöscht", async () => {
    const e1 = fakeTrashEntry();
    const e2 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
    });
    const e3 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/shadercache_730_200",
      name: "shadercache_730_200",
      type: "shadercache",
      appId: 730,
    });

    let callCount = 0;
    mockExecuteDelete.mockImplementation(async (token: string) => {
      callCount++;
      if (callCount === 2) throw new Error("permission denied");
      return { success: true, deletedPath: token };
    });

    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [e1, e2, e3];

    await store.emptyTrash();
    await useConfirmStore().confirm();

    expect(store.trash).toHaveLength(1);
    expect(store.trash[0]?.appId).toBe(570); // der fehlgeschlagene bleibt
    expect(store.error).toContain("compatdata_570_100");
    expect(store.error).toContain("permission denied");
  });

  it("behält vorbereitungs- und execute-fehler getrennt sichtbar", async () => {
    const e1 = fakeTrashEntry();
    const e2 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
    });
    mockPrepareDelete.mockImplementation(async (req) => {
      if (req.path === e2.path) throw new Error("not readable");
      return {
        token: `token-${req.path}`,
        expiresAt: Date.now() + 60000,
        targetType: req.targetType,
        targetPath: req.path,
        consequences: [],
      };
    });
    mockExecuteDelete.mockRejectedValue(new Error("permission denied"));
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [e1, e2];

    await store.deleteTrashEntries([e1, e2]);
    await useConfirmStore().confirm();

    expect(store.error).toContain("nicht vorbereitete Einträge (1)");
    expect(store.error).toContain("nicht gelöschte Einträge (1)");
    expect(store.error).toContain("not readable");
    expect(store.error).toContain("permission denied");
  });

  it("deleteTrashEntry entfernt genau einen eintrag", async () => {
    const e1 = fakeTrashEntry();
    const e2 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
    });

    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [e1, e2];

    await store.deleteTrashEntry(e1);
    await useConfirmStore().confirm();

    expect(store.trash).toHaveLength(1);
    expect(store.trash[0]?.appId).toBe(570);
    expect(mockPrepareDelete).toHaveBeenCalledTimes(1);
    expect(mockPrepareDelete).toHaveBeenCalledWith({
      targetType: "trash",
      path: e1.path,
      steamRoot: "/home/u/.steam",
    });
    expect(mockExecuteDelete).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe("cleanupStore, scan-generationen", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockFindOrphans.mockReset();
    mockFindIncompleteDeletions.mockReset();
    mockFindSteamOwnedPrefixes.mockReset();
    mockFindTrashEntries.mockReset();
    mockReadAllShortcutAppIds.mockReset();
    mockBatchDirSizes.mockReset();
    mockBatchDirSizes.mockImplementation(async (paths) =>
      Object.fromEntries(paths.map((path) => [path, { status: "missing" as const }])),
    );
    mockFindOrphans.mockResolvedValue([]);
    mockFindIncompleteDeletions.mockResolvedValue({ entries: [], unreadable: [] });
    mockFindSteamOwnedPrefixes.mockResolvedValue([]);
    mockFindTrashEntries.mockResolvedValue({
      entries: [],
      unknown: [],
      unreadable: [],
      libraries: [],
    });
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
  });

  it("leert orphan-kandidaten und status bei frühem scan-abbruch", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const orphan = {
      appId: 570,
      type: "compatdata" as const,
      path: "/lib/compatdata/570",
      library: "/lib",
      sizeBytes: 8192,
    };
    mockFindOrphans.mockResolvedValueOnce([orphan]);
    mockFindSteamOwnedPrefixes.mockResolvedValueOnce([
      { appId: 4628710, path: "/lib/compatdata/4628710", library: "/lib", sizeBytes: 4096 },
    ]);
    mockFindIncompleteDeletions.mockResolvedValueOnce({
      entries: [
        {
          path: "/lib/compatdata/.protium-delete-claim-1",
          library: "/lib",
          type: "compatdata",
          name: ".protium-delete-claim-1",
        },
      ],
      unreadable: [],
    });

    await store.scanOrphans();
    expect(store.orphans).toHaveLength(1);
    expect(store.steamOwnedPrefixes).toHaveLength(1);
    expect(store.incompleteDeletions).toHaveLength(1);

    scanStore.result = fakeScan([{ path: "/broken", reason: "read-failed" }]);
    await store.scanOrphans();

    expect(store.orphans).toEqual([]);
    expect(store.orphanNames).toEqual({});
    expect(store.steamOwnedPrefixes).toEqual([]);
    expect(store.incompleteDeletions).toEqual([]);
    expect(store.pathMissingLibs).toEqual([]);
    expect(store.shortcutUnreadable).toBe(false);
    expect(store.blockedBySkipped).toBe(true);
    expect(store.scanning).toBe(false);
    expect(store.error).toContain("/broken");
  });

  it("leert trash-kandidaten und status bei fehlendem scan-ergebnis", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    mockFindTrashEntries.mockResolvedValueOnce({
      entries: [entry],
      unknown: ["/lib/unknown"],
      unreadable: ["/lib/unreadable"],
      libraries: [
        {
          library: "/lib",
          dir: "/lib/steamapps/.protium-trash",
          present: true,
          count: 1,
        },
      ],
    });

    await store.scanTrash();
    expect(store.trash).toHaveLength(1);
    expect(store.trashUnknown).toEqual(["/lib/unknown"]);
    expect(store.trashLibraries).toHaveLength(1);

    scanStore.result = null;
    await store.scanTrash();

    expect(store.trash).toEqual([]);
    expect(store.trashUnknown).toEqual([]);
    expect(store.trashLibraries).toEqual([]);
    expect(store.trashScanning).toBe(false);
    expect(store.error).toContain("scan-ergebnis");
  });

  it("verwirft stale orphan-ergebnisse samt catch und finally", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const first = deferred<ReturnType<typeof findOrphans> extends Promise<infer T> ? T : never>();
    const oldOrphan = {
      appId: 570,
      type: "compatdata" as const,
      path: "/old/compatdata/570",
      library: "/old",
    };
    const newOrphan = {
      appId: 730,
      type: "shadercache" as const,
      path: "/new/shadercache/730",
      library: "/new",
    };
    mockFindOrphans.mockImplementationOnce(() => first.promise).mockResolvedValueOnce([newOrphan]);

    const oldScan = store.scanOrphans();
    await vi.waitFor(() => expect(mockFindOrphans).toHaveBeenCalledTimes(1));
    const newScan = store.scanOrphans();
    await newScan;
    expect(store.orphans).toEqual([newOrphan]);
    expect(store.scanning).toBe(false);

    first.resolve([oldOrphan]);
    await oldScan;
    expect(store.orphans).toEqual([newOrphan]);
    expect(store.scanning).toBe(false);

    const second = deferred<ReturnType<typeof findOrphans> extends Promise<infer T> ? T : never>();
    mockFindOrphans.mockImplementationOnce(() => second.promise);
    const staleErrorScan = store.scanOrphans();
    await vi.waitFor(() => expect(mockFindOrphans).toHaveBeenCalledTimes(3));
    const currentError = "aktueller scan-fehler";
    mockFindOrphans.mockRejectedValueOnce(new Error(currentError));
    const currentScan = store.scanOrphans();
    await currentScan;
    expect(store.error).toContain(currentError);
    second.reject(new Error("alter scan-fehler"));
    await staleErrorScan;
    expect(store.error).toContain(currentError);
    expect(store.error).not.toContain("alter scan-fehler");
    expect(store.scanning).toBe(false);
  });

  it("verwirft stale trash-ergebnisse und schützt den aktuellen fehler", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const first = deferred<Awaited<ReturnType<typeof findTrashEntries>>>();
    const oldEntry = fakeTrashEntry({ path: "/old/trash/entry" });
    const newEntry = fakeTrashEntry({ path: "/new/trash/entry" });
    mockFindTrashEntries
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        entries: [newEntry],
        unknown: [],
        unreadable: [],
        libraries: [],
      });

    const oldScan = store.scanTrash();
    await vi.waitFor(() => expect(mockFindTrashEntries).toHaveBeenCalledTimes(1));
    await store.scanTrash();
    expect(store.trash).toEqual([newEntry]);
    expect(store.trashScanning).toBe(false);

    first.resolve({
      entries: [oldEntry],
      unknown: ["/old/unknown"],
      unreadable: [],
      libraries: [],
    });
    await oldScan;
    expect(store.trash).toEqual([newEntry]);
    expect(store.trashUnknown).toEqual([]);
    expect(store.trashScanning).toBe(false);
  });

  it("verwirft cleanup-ergebnisse und fehler nach einem source-scan-race", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    scanStore.status = "done";
    const store = useCleanupStore();
    const orphanRead = deferred<Awaited<ReturnType<typeof findOrphans>>>();
    const trashRead = deferred<Awaited<ReturnType<typeof findTrashEntries>>>();
    const staleOrphan = {
      appId: 570,
      type: "compatdata" as const,
      path: "/old/compatdata/570",
      library: "/old",
    };
    mockFindOrphans.mockImplementationOnce(() => orphanRead.promise);
    mockFindTrashEntries.mockImplementationOnce(() => trashRead.promise);

    const orphanScan = store.scanOrphans();
    await vi.waitFor(() => expect(mockFindOrphans).toHaveBeenCalledTimes(1));
    const trashScan = store.scanTrash();
    await vi.waitFor(() => expect(mockFindTrashEntries).toHaveBeenCalledTimes(1));

    scanStore.scanGeneration += 1;
    scanStore.status = "scanning";
    const currentOrphan = {
      appId: 730,
      type: "shadercache" as const,
      path: "/current/shadercache/730",
      library: "/current",
    };
    const currentTrash = fakeTrashEntry({ path: "/current/trash/entry" });
    store.orphans = [currentOrphan];
    store.trash = [currentTrash];
    store.error = "aktueller cleanup-fehler";
    store.scanning = false;
    store.trashScanning = false;

    orphanRead.resolve([staleOrphan]);
    trashRead.reject(new Error("stale trash-fehler"));
    await Promise.all([orphanScan, trashScan]);

    expect(store.orphans).toEqual([currentOrphan]);
    expect(store.trash).toEqual([currentTrash]);
    expect(store.error).toBe("aktueller cleanup-fehler");
    expect(store.error).not.toContain("stale trash-fehler");
  });

  it("orphans und trash invalidieren einander nicht", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const orphanResult =
      deferred<ReturnType<typeof findOrphans> extends Promise<infer T> ? T : never>();
    const orphan = {
      appId: 570,
      type: "compatdata" as const,
      path: "/lib/compatdata/570",
      library: "/lib",
    };
    const trash = fakeTrashEntry();
    mockFindOrphans.mockImplementationOnce(() => orphanResult.promise);
    mockFindTrashEntries.mockResolvedValueOnce({
      entries: [trash],
      unknown: [],
      unreadable: [],
      libraries: [],
    });

    const orphanScan = store.scanOrphans();
    await vi.waitFor(() => expect(mockFindOrphans).toHaveBeenCalledTimes(1));
    await store.scanTrash();
    orphanResult.resolve([orphan]);
    await orphanScan;

    expect(store.orphans).toEqual([orphan]);
    expect(store.trash).toEqual([trash]);
  });
});

describe("cleanupStore, papierkorb-refresh nach dem löschen", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockFindOrphans.mockReset();
    mockReadAllShortcutAppIds.mockReset();
    mockFindTrashEntries.mockReset();
    mockPrepareDelete.mockReset();
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [],
    }));
    mockExecuteDelete.mockReset();
    mockExecuteDelete.mockResolvedValue({ success: true, deletedPath: "" });
    mockFindOrphans.mockResolvedValue([]);
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
    mockFindTrashEntries.mockResolvedValue({
      entries: [],
      unknown: [],
      unreadable: [],
      libraries: [],
    });
    mockBatchDirSizes.mockReset();
    mockBatchDirSizes.mockImplementation(async (paths) =>
      Object.fromEntries(paths.map((path) => [path, { status: "missing" as const }])),
    );
  });

  it("compatdata löschen lädt den papierkorb neu", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.deleteOrphans([
      {
        appId: 999999,
        type: "compatdata",
        path: "/lib/steamapps/compatdata/999999",
        library: "/lib",
      },
    ]);
    await useConfirmStore().confirm();

    // ohne diesen refresh bleibt die papierkorb-sektion leer, obwohl gerade
    // ein prefix hineinverschoben wurde
    expect(mockFindTrashEntries).toHaveBeenCalled();
  });

  it("shadercache löschen lädt den papierkorb NICHT neu (hard delete)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.deleteOrphans([
      {
        appId: 888888,
        type: "shadercache",
        path: "/lib/steamapps/shadercache/888888",
        library: "/lib",
      },
    ]);
    await useConfirmStore().confirm();

    expect(mockFindTrashEntries).not.toHaveBeenCalled();
  });

  it("löschfehler bleibt erhalten, obwohl scanTrash den fehler zurücksetzt", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanWithGames([999999]); // appId inzwischen installiert
    const store = useCleanupStore();

    await store.deleteOrphans([
      {
        appId: 999999,
        type: "compatdata",
        path: "/lib/steamapps/compatdata/999999",
        library: "/lib",
      },
    ]);

    expect(store.error).toContain("inzwischen installiert");
  });

  it("löschfehler überlebt den internen orphan-rescan (scanOrphans setzt error zurück)", async () => {
    mockExecuteDelete.mockRejectedValue(new Error("permission denied"));
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.deleteOrphans([
      {
        appId: 888888,
        type: "shadercache",
        path: "/lib/steamapps/shadercache/888888",
        library: "/lib",
      },
    ]);
    await useConfirmStore().confirm();

    // der rescan muss gelaufen sein (liste aktualisiert) UND der fehler
    // darf davon nicht weggewischt worden sein
    expect(mockFindOrphans).toHaveBeenCalled();
    expect(store.error).toContain("888888");
    expect(store.error).toContain("permission denied");
  });

  it("orphan-onError räumt deleting nach unerwartetem execute-folgefehler auf", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.scanOrphans = vi.fn(async () => {
      throw new Error("rescan failed");
    });
    const entry = {
      appId: 888888,
      type: "shadercache" as const,
      path: "/lib/steamapps/shadercache/888888",
      library: "/lib",
    };

    await store.deleteOrphans([entry]);
    await useConfirmStore().confirm();

    expect(store.deleting.size).toBe(0);
    expect(store.error).toContain("rescan failed");
  });

  it("alter orphan-delete-callback überschreibt keinen aktuellen scan-fehler", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = {
      appId: 888888,
      type: "shadercache" as const,
      path: "/lib/steamapps/shadercache/888888",
      library: "/lib",
    };
    const execute = deferred<{ success: boolean; deletedPath: string }>();
    mockExecuteDelete.mockImplementationOnce(() => execute.promise);

    await store.deleteOrphans([entry]);
    const confirmPromise = useConfirmStore().confirm();
    await vi.waitFor(() => expect(mockExecuteDelete).toHaveBeenCalledTimes(1));

    mockFindOrphans.mockRejectedValueOnce(new Error("aktueller scan-fehler"));
    await store.scanOrphans();
    expect(store.error).toContain("aktueller scan-fehler");

    execute.reject(new Error("alter delete-fehler"));
    await confirmPromise;

    expect(store.error).toContain("aktueller scan-fehler");
    expect(store.error).not.toContain("alter delete-fehler");
    expect(store.deleting.size).toBe(0);
    expect(useConfirmStore().reserved).toBe(false);
  });

  it("alter trash-delete-callback überschreibt keinen aktuellen scan-fehler", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    const execute = deferred<{ success: boolean; deletedPath: string }>();
    mockExecuteDelete.mockImplementationOnce(() => execute.promise);

    await store.deleteTrashEntries([entry]);
    const confirmPromise = useConfirmStore().confirm();
    await vi.waitFor(() => expect(mockExecuteDelete).toHaveBeenCalledTimes(1));

    mockFindTrashEntries.mockRejectedValueOnce(new Error("aktueller trash-scan-fehler"));
    await store.scanTrash();
    expect(store.error).toContain("aktueller trash-scan-fehler");

    execute.reject(new Error("alter trash-delete-fehler"));
    await confirmPromise;

    expect(store.error).toContain("aktueller trash-scan-fehler");
    expect(store.error).not.toContain("alter trash-delete-fehler");
    expect(useConfirmStore().reserved).toBe(false);
  });
});

describe("cleanupStore, S-02: Pfadbasierte Keys (A-04)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockFindOrphans.mockReset();
    mockReadAllShortcutAppIds.mockReset();
    mockPrepareDelete.mockReset();
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [],
    }));
    mockExecuteDelete.mockReset();
    mockExecuteDelete.mockResolvedValue({ success: true, deletedPath: "" });
    mockBatchDirSizes.mockReset();
    mockBatchDirSizes.mockImplementation(async (paths) =>
      Object.fromEntries(paths.map((path) => [path, { status: "missing" as const }])),
    );
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
  });

  it("deleteOrphans: prepare-fehler räumt deleting auf, erneuter versuch möglich", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    mockPrepareDelete.mockRejectedValue(new Error("prepare failed"));

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);

    expect(store.error).toContain("prepare failed");
    expect(store.deleting.size).toBe(0);
    expect(useConfirmStore().pending).toBeNull();

    // erneuter versuch nach fehlerbehebung läuft durch den dialog
    mockPrepareDelete.mockResolvedValue({
      token: "token-1",
      expiresAt: Date.now() + 60000,
      targetType: "orphan",
      targetPath: "/fake/wine",
      consequences: [],
    });
    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);
    expect(useConfirmStore().pending).not.toBeNull();
    expect(store.deleting.size).toBe(1); // während des dialogs belegt

    await useConfirmStore().cancel();
    expect(store.deleting.size).toBe(0);
  });

  it("key(entry) liefert den vollständigen Pfad", () => {
    const store = useCleanupStore();
    const entry = {
      appId: 570,
      type: "compatdata" as const,
      path: "/lib1/steamapps/compatdata/570",
      library: "/lib1",
    };
    expect(store.key(entry)).toBe("/lib1/steamapps/compatdata/570");
  });

  it("gleiche AppID in unterschiedlichen Libraries erzeugt unterschiedliche Keys", () => {
    const store = useCleanupStore();
    const entry1 = {
      appId: 570,
      type: "compatdata" as const,
      path: "/lib1/steamapps/compatdata/570",
      library: "/lib1",
    };
    const entry2 = {
      appId: 570,
      type: "compatdata" as const,
      path: "/lib2/steamapps/compatdata/570",
      library: "/lib2",
    };
    expect(store.key(entry1)).not.toBe(store.key(entry2));
  });

  it("Unavailable-Getter teilen nur die Claim-Lesefehler-Basis", () => {
    const store = useCleanupStore();

    store.incompleteDeletionsUnreadable = ["/lib/steamapps/compatdata"];
    expect(store.shaderUnavailable).toBe(true);
    expect(store.prefixUnavailable).toBe(true);
    expect(store.trashUnavailable).toBe(true);

    store.incompleteDeletionsUnreadable = [];
    store.blockedBySkipped = true;
    expect(store.shaderUnavailable).toBe(true);
    expect(store.prefixUnavailable).toBe(true);
    expect(store.trashUnavailable).toBe(false);

    store.blockedBySkipped = false;
    store.orphanError = "orphan-scan failed";
    expect(store.shaderUnavailable).toBe(true);
    expect(store.prefixUnavailable).toBe(true);
    expect(store.trashUnavailable).toBe(false);
  });

  it("Löschen eines Eintrags entfernt nur den betroffenen Pfad", async () => {
    const entry1 = {
      appId: 570,
      type: "compatdata" as const,
      path: "/lib1/steamapps/compatdata/570",
      library: "/lib1",
    };
    const entry2 = {
      appId: 570,
      type: "compatdata" as const,
      path: "/lib2/steamapps/compatdata/570",
      library: "/lib2",
    };

    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.orphans = [entry1, entry2];

    // Mock findOrphans beim rescan so, dass nur noch entry2 existiert
    mockFindOrphans.mockResolvedValue([entry2]);

    await store.deleteOrphans([entry1]);
    await useConfirmStore().confirm();

    expect(mockPrepareDelete).toHaveBeenCalledTimes(1);
    expect(mockPrepareDelete).toHaveBeenCalledWith({
      targetType: "orphan",
      path: entry1.path,
      steamRoot: "/home/u/.steam",
    });
    expect(mockExecuteDelete).toHaveBeenCalledTimes(1);
    expect(store.orphans).toEqual([entry2]);
  });
});
