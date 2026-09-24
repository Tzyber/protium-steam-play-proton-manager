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
import type { OrphanEntry, ScanResult } from "../../src/core/types";
import { formatBytes } from "../../src/ui/format";
import { setLocale, t } from "../../src/ui/i18n";

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
    deletedPath: "",
  })),
  mockBatchDirSizes: vi.fn<(paths: string[]) => Promise<Record<string, DirectorySize>>>(
    async (paths) =>
      Object.fromEntries(paths.map((path) => [path, { status: "missing" as const }])),
  ),
  mockReadLocalConfig: vi.fn(async () => ""),
  mockIsProcessRunning: vi.fn(async () => false),
}));

vi.mock("../../src/core/cleanup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/cleanup")>();
  return {
    findOrphans: mockFindOrphans,
    findIncompleteDeletions: mockFindIncompleteDeletions,
    findSteamOwnedPrefixes: mockFindSteamOwnedPrefixes,
    // klassifikation (U-04) ist rein und wird ungemockt mitgetestet
    classifyOrphans: actual.classifyOrphans,
  };
});
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

import { useScanStore } from "../../src/ui/stores/scanStore";
import { deferred, game as makeGame, scanResult } from "../support/factories";

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
  return scanResult({
    skippedLibraries: skipped ?? [],
    cleanupUnsafeLibraries: cleanupUnsafeLibraries ?? [],
  });
}

function fakeScanWithoutCleanupSafety(): ScanResult {
  const result = fakeScan();
  Reflect.deleteProperty(result, "cleanupUnsafeLibraries");
  return result;
}

function fakeScanWithGames(gameIds: number[]): ScanResult {
  return { ...fakeScan(), games: gameIds.map((appId) => makeGame({ appId })) };
}

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

function fakeOrphanEntry(index: number): OrphanEntry {
  return {
    appId: 900000 + index,
    type: "shadercache",
    path: `/lib/steamapps/shadercache/${900000 + index}`,
    library: "/lib",
  };
}

function fakeOrphanEntries(count: number): OrphanEntry[] {
  return Array.from({ length: count }, (_, index) => fakeOrphanEntry(index + 1));
}

function fakeTrashEntries(count: number): TrashEntry[] {
  return Array.from({ length: count }, (_, index) =>
    fakeTrashEntry({
      path: `/lib/steamapps/.protium-trash/compatdata_${1000000 + index}_100`,
      name: `compatdata_${1000000 + index}_100`,
      appId: 1000000 + index,
    }),
  );
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
    mockExecuteDelete.mockResolvedValue({ deletedPath: "" });
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

  it("blockiert wenn der snapshot keine unavailable-libraries belegt", async () => {
    // F1: ein snapshot ohne belegten discovery-zustand darf das cleanup nicht
    // stillschweigend freigeben.
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/home/u/.steam", reason: "unverified" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.orphans).toEqual([]);
  });

  it("bewahrt getrennte orphan- und trash-fehler beim jeweils anderen scan", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    mockFindOrphans.mockRejectedValue(new Error("unreadable"));

    await store.scanOrphans();
    expect(store.error).toContain("unlesbar");

    mockFindTrashEntries.mockResolvedValue({
      entries: [],
      unknown: [],
      unreadable: ["/home/u/.steam"],
      libraries: [],
    });
    await store.scanTrash();

    expect(store.error).toContain("unlesbar");
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
    expect(store.error).toContain("Sicherheitsfeld");
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
    expect(store.error).toContain("Sicherheitsfeld");
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
    mockExecuteDelete.mockResolvedValue({ deletedPath: "" });
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

  it("lehnt mehr als 32 orphan-einträge vor allen gates ab", async () => {
    const scanStore = useScanStore();
    scanStore.result = null;
    const store = useCleanupStore();
    const existing = fakeOrphanEntry(0);
    store.orphans = [existing];
    store.blockedBySkipped = true;

    await store.deleteOrphans(Array.from({ length: 33 }, (_, index) => fakeOrphanEntry(index + 1)));

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(mockReadAllShortcutAppIds).not.toHaveBeenCalled();
    expect(mockIsProcessRunning).not.toHaveBeenCalled();
    expect(useConfirmStore().pending).toBeNull();
    expect(useConfirmStore().reserved).toBe(false);
    expect(store.deleting.size).toBe(0);
    expect(store.orphans).toEqual([existing]);
    expect(store.error).toContain("33");
    expect(store.error).toContain("32");
  });

  it("bereitet und führt exakt 32 orphan-einträge in einem dialog aus", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockFindOrphans.mockResolvedValue([]);
    const store = useCleanupStore();
    const entries = Array.from({ length: 32 }, (_, index) => fakeOrphanEntry(index));
    store.orphans = [...entries];

    await store.deleteOrphans(entries);

    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(useConfirmStore().pending?.title).toContain("32");
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
    expect(store.deleting.size).toBe(0);
  });

  it("setzt bei reinen papierkorb-verschiebungen den knopf auf verschieben", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [
        {
          path: req.path,
          action: "trash" as const,
          description: "Prefix in den Papierkorb verschieben",
          affectedAppIds: [999999],
        },
      ],
    }));
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);

    expect(useConfirmStore().pending?.confirmLabel).toBe(t("cleanup.moveToTrash"));
  });

  it("setzt bei endgültigem löschen den knopf auf löschen", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [
        {
          path: req.path,
          action: "permanentDelete" as const,
          description: "Shader-Cache dauerhaft löschen",
          affectedAppIds: [999999],
        },
      ],
    }));
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 999999, type: "shadercache", path: "/fake/shader", library: "/lib" },
    ]);

    expect(useConfirmStore().pending?.confirmLabel).toBe(t("common.delete"));
  });

  it("setzt den knopf auf löschen sobald ein eintrag endgültig gelöscht wird", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [
        {
          path: req.path,
          action: req.path === "/fake/shader" ? ("permanentDelete" as const) : ("trash" as const),
          description: "gemischt",
          affectedAppIds: [999999],
        },
      ],
    }));
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
      { appId: 999999, type: "shadercache", path: "/fake/shader", library: "/lib" },
    ]);

    expect(useConfirmStore().pending?.confirmLabel).toBe(t("common.delete"));
  });

  it("nennt im orphan-dialog den spielnamen aus orphanNames", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [
        {
          path: req.path,
          action: "trash" as const,
          description: "Prefix in den Papierkorb verschieben",
          affectedAppIds: [999999],
        },
      ],
    }));
    const store = useCleanupStore();
    store.orphanNames = { "/fake/wine": "Portal 2" };

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);

    expect(useConfirmStore().pending?.message).toContain("Portal 2");
  });

  it("deleteOrphansAll verarbeitet nur die ersten 32 einträge und nennt den rest", async () => {
    const entries = fakeOrphanEntries(33);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockFindOrphans.mockResolvedValue([]);
    const store = useCleanupStore();
    store.orphans = [...entries];

    await store.deleteOrphansAll(entries);

    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(mockPrepareDelete).not.toHaveBeenCalledWith({
      targetType: "orphan",
      path: entries[32]?.path,
      steamRoot: "/home/u/.steam",
    });
    expect(useConfirmStore().pending?.title).toContain("32");
    expect(useConfirmStore().pending?.message).toContain(
      "je durchgang höchstens 32 einträge; danach verbleiben: 1.",
    );
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
  });

  it("deleteOrphansAll nennt grenze und rest auch bei deutlich mehr als 32 einträgen", async () => {
    const entries = fakeOrphanEntries(70);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockFindOrphans.mockResolvedValue([]);
    const store = useCleanupStore();
    store.orphans = [...entries];

    await store.deleteOrphansAll(entries);

    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(useConfirmStore().pending?.message).toContain(
      "je durchgang höchstens 32 einträge; danach verbleiben: 38.",
    );
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
  });

  it("deleteOrphansAll mit genau 32 einträgen nennt keinen rest", async () => {
    const entries = fakeOrphanEntries(32);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockFindOrphans.mockResolvedValue([]);
    const store = useCleanupStore();
    store.orphans = [...entries];

    await store.deleteOrphansAll(entries);

    expect(useConfirmStore().pending?.title).toContain("32");
    expect(useConfirmStore().pending?.message).not.toContain("danach verbleiben");
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
  });

  it("deleteOrphansAll meldet die grenze auch auf englisch", async () => {
    setLocale("en");
    const entries = fakeOrphanEntries(33);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockFindOrphans.mockResolvedValue([]);
    const store = useCleanupStore();
    store.orphans = [...entries];

    await store.deleteOrphansAll(entries);

    expect(useConfirmStore().pending?.title).toContain("32");
    expect(useConfirmStore().pending?.message).toContain(
      "at most 32 entries per pass; remaining afterwards: 1.",
    );
  });
});

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
    mockExecuteDelete.mockResolvedValue({ deletedPath: "" });
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
    expect(useConfirmStore().pending?.title).toBe("2 papierkorb-einträge endgültig löschen?");
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
      if (req.path === e2.path) throw new Error("unreadable");
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
    expect(store.error).toContain("unlesbar");
    expect(useConfirmStore().pending?.message).toContain(
      "nicht vorbereitete Einträge (1) bleiben unverändert.",
    );
    expect(useConfirmStore().pending?.title).toContain("1");
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(1);
    expect(store.trash).toEqual([e2]);
  });

  it("lehnt mehr als 32 direkte trash-einträge vor allen gates ab", async () => {
    setLocale("en");
    const scanStore = useScanStore();
    scanStore.result = null;
    const store = useCleanupStore();
    const existing = fakeTrashEntry({ path: "/existing/trash-entry" });
    store.trash = [existing];

    await store.deleteTrashEntries(fakeTrashEntries(33));

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(useConfirmStore().pending).toBeNull();
    expect(useConfirmStore().reserved).toBe(false);
    expect(store.trash).toEqual([existing]);
    expect(store.error).toContain("33");
    expect(store.error).toContain("32");
  });

  it("bereitet und führt exakt 32 trash-einträge in einem dialog aus", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entries = fakeTrashEntries(32);
    store.trash = [...entries];

    await store.deleteTrashEntries(entries);

    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(useConfirmStore().pending?.title).toContain("32");
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
    expect(store.trash).toEqual([]);
  });

  it("deleteTrashEntries beginnt die bestätigung mit der unwiderruflichkeits-warnung und nennt die summengröße", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const e1 = fakeTrashEntry({ sizeBytes: 8192 });
    const e2 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
      sizeBytes: 1048576,
    });
    store.trash = [e1, e2];

    await store.deleteTrashEntries([e1, e2]);

    const message = useConfirmStore().pending?.message ?? "";
    expect(message.startsWith("Unwiderruflich")).toBe(true);
    expect(message).toContain(formatBytes(8192 + 1048576));
  });

  it("nennt in der bestätigung nur die größe der tatsächlich vorbereiteten einträge (N7)", async () => {
    const e1 = fakeTrashEntry({ sizeBytes: 4096 });
    const e2 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
      sizeBytes: 1048576,
    });
    mockPrepareDelete.mockImplementation(async (req) => {
      if (req.path === e2.path) throw new Error("unreadable");
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

    const message = useConfirmStore().pending?.message ?? "";
    expect(message).toContain(formatBytes(4096));
    expect(message).not.toContain(formatBytes(4096 + 1048576));
    expect(message).toContain("nicht vorbereitete Einträge (1) bleiben unverändert.");
  });

  it("weist teilweise unbekannte größen als teilweise aus, nicht als 0 (N7)", async () => {
    const measured = fakeTrashEntry({ sizeBytes: 4096 });
    const unmeasured = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [measured, unmeasured];

    await store.deleteTrashEntries([measured, unmeasured]);

    const message = useConfirmStore().pending?.message ?? "";
    expect(message).toContain(t("cleanup.partialSize", { size: formatBytes(4096) }));
  });

  it("nennt eine durchgehend unbekannte größe nicht gemessen, nicht 0 B (N7)", async () => {
    const unmeasured = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_730_100",
      name: "compatdata_730_100",
      appId: 730,
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [unmeasured];

    await store.deleteTrashEntries([unmeasured]);

    const message = useConfirmStore().pending?.message ?? "";
    expect(message).toContain(t("common.notMeasured"));
    expect(message).not.toContain("0 B");
  });

  it("ohne erfolgreiches prepare gibt es keinen dialog und kein execute", async () => {
    mockPrepareDelete.mockRejectedValue(new Error("unreadable"));
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const e1 = fakeTrashEntry();

    await store.deleteTrashEntries([e1]);

    expect(store.error).toContain("unlesbar");
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
    expect(deleteSpy.mock.calls[0]?.[1]).toBe(0);
  });

  it("emptyTrash verarbeitet nur die ersten 32 snapshot-einträge und nennt den rest", async () => {
    const entries = fakeTrashEntries(33);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [...entries];

    await store.emptyTrash();

    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(mockPrepareDelete).not.toHaveBeenCalledWith({
      targetType: "trash",
      path: entries[32]?.path,
      steamRoot: "/home/u/.steam",
    });
    expect(useConfirmStore().pending?.title).toContain("32");
    expect(useConfirmStore().pending?.message).toContain(
      "je durchgang höchstens 32 einträge; rest im papierkorb: 1.",
    );
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
    expect(store.trash).toEqual([entries[32]]);
  });

  it("emptyTrash nennt grenze und rest auch bei deutlich mehr als 32 einträgen", async () => {
    const entries = fakeTrashEntries(70);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [...entries];

    await store.emptyTrash();

    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(useConfirmStore().pending?.message).toContain(
      "je durchgang höchstens 32 einträge; rest im papierkorb: 38.",
    );
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
    expect(store.trash).toHaveLength(38);
    expect(store.trash[0]?.path).toBe(entries[32]?.path);
  });

  it("emptyTrash mit genau 32 einträgen nennt keinen rest", async () => {
    const entries = fakeTrashEntries(32);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [...entries];

    await store.emptyTrash();

    expect(useConfirmStore().pending?.title).toContain("32");
    expect(useConfirmStore().pending?.message).not.toContain("rest im papierkorb");
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
    expect(store.trash).toEqual([]);
  });

  it("emptyTrash meldet die grenze auch auf englisch", async () => {
    setLocale("en");
    const entries = fakeTrashEntries(33);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [...entries];

    await store.emptyTrash();

    expect(useConfirmStore().pending?.title).toContain("32");
    expect(useConfirmStore().pending?.message).toContain(
      "at most 32 entries per pass; remaining in the trash: 1.",
    );
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
      if (callCount === 2) throw new Error("unreadable");
      return { deletedPath: token };
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
    expect(store.error).toContain("unlesbar");
  });

  it("behält vorbereitungs- und execute-fehler getrennt sichtbar", async () => {
    const e1 = fakeTrashEntry();
    const e2 = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
    });
    mockPrepareDelete.mockImplementation(async (req) => {
      if (req.path === e2.path) throw new Error("unreadable");
      return {
        token: `token-${req.path}`,
        expiresAt: Date.now() + 60000,
        targetType: req.targetType,
        targetPath: req.path,
        consequences: [],
      };
    });
    mockExecuteDelete.mockRejectedValue(new Error("unreadable"));
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [e1, e2];

    await store.deleteTrashEntries([e1, e2]);
    await useConfirmStore().confirm();

    expect(store.error).toContain("nicht vorbereitete Einträge (1)");
    expect(store.error).toContain("nicht gelöschte Einträge (1)");
    expect(store.error).toContain("unlesbar");
    expect(store.error).toContain("unlesbar");
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
    mockExecuteDelete.mockResolvedValue({ deletedPath: "" });
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
    mockExecuteDelete.mockRejectedValue(new Error("unreadable"));
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
    expect(store.error).toContain("unlesbar");
  });

  it("orphan-onError räumt deleting nach unerwartetem execute-folgefehler auf", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.scanOrphans = vi.fn(async () => {
      throw new Error("unreadable");
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
    expect(store.error).toContain("unlesbar");
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
    const execute = deferred<{ deletedPath: string }>();
    mockExecuteDelete.mockImplementationOnce(() => execute.promise);

    await store.deleteOrphans([entry]);
    const confirmPromise = useConfirmStore().confirm();
    await vi.waitFor(() => expect(mockExecuteDelete).toHaveBeenCalledTimes(1));

    mockFindOrphans.mockRejectedValueOnce(new Error("unreadable"));
    await store.scanOrphans();
    expect(store.error).toContain("unlesbar");

    execute.reject(new Error("alter delete-fehler"));
    await confirmPromise;

    expect(store.error).toContain("unlesbar");
    expect(store.error).not.toContain("alter delete-fehler");
    expect(store.deleting.size).toBe(0);
    expect(useConfirmStore().reserved).toBe(false);
  });

  it("alter trash-delete-callback überschreibt keinen aktuellen scan-fehler", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    const execute = deferred<{ deletedPath: string }>();
    mockExecuteDelete.mockImplementationOnce(() => execute.promise);

    await store.deleteTrashEntries([entry]);
    const confirmPromise = useConfirmStore().confirm();
    await vi.waitFor(() => expect(mockExecuteDelete).toHaveBeenCalledTimes(1));

    mockFindTrashEntries.mockRejectedValueOnce(new Error("unreadable"));
    await store.scanTrash();
    expect(store.error).toContain("unlesbar");

    execute.reject(new Error("alter trash-delete-fehler"));
    await confirmPromise;

    expect(store.error).toContain("unlesbar");
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
    mockExecuteDelete.mockResolvedValue({ deletedPath: "" });
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
    mockPrepareDelete.mockRejectedValue(new Error("unreadable"));

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);

    expect(store.error).toContain("unlesbar");
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

  it("orphanKey(entry) liefert den vollständigen Pfad", () => {
    const store = useCleanupStore();
    const entry = {
      appId: 570,
      type: "compatdata" as const,
      path: "/lib1/steamapps/compatdata/570",
      library: "/lib1",
    };
    expect(store.orphanKey(entry)).toBe("/lib1/steamapps/compatdata/570");
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
    expect(store.orphanKey(entry1)).not.toBe(store.orphanKey(entry2));
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
