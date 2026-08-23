import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { findOrphans } from "../../src/core/cleanup";
import type { readAllShortcutAppIds } from "../../src/core/shortcuts";
import type { findTrashEntries, TrashEntry } from "../../src/core/trash";
import type { ScanResult } from "../../src/core/types";
import { formatBytes } from "../../src/ui/format";
import { setLocale } from "../../src/ui/i18n";

const {
  mockFindOrphans,
  mockReadAllShortcutAppIds,
  mockFindTrashEntries,
  mockPrepareDelete,
  mockExecuteDelete,
  mockBatchDirSizes,
} = vi.hoisted(() => ({
  mockFindOrphans: vi.fn<typeof findOrphans>(async () => []),
  mockReadAllShortcutAppIds: vi.fn<typeof readAllShortcutAppIds>(async () => ({
    status: "none" as const,
  })),
  mockFindTrashEntries: vi.fn<typeof findTrashEntries>(async () => ({
    entries: [],
    unknown: [],
    unreadable: [],
    libraries: [],
  })),
  mockPrepareDelete: vi.fn(async (req) => ({
    token: `token-${req.path}`,
    expiresAt: Date.now() + 60000,
    targetType: req.targetType,
    targetPath: req.path,
    consequences: [],
  })),
  mockExecuteDelete: vi.fn(async (_token: string) => ({
    success: true,
    deletedPath: "",
  })),
  mockBatchDirSizes: vi.fn<(paths: string[]) => Promise<Record<string, number>>>(async () => ({})),
}));

vi.mock("../../src/core/cleanup", () => ({
  findOrphans: mockFindOrphans,
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
    fs: {},
    http: {},
    system: {
      isProcessRunning: async () => false,
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
    steamUserId: null,
    warnings: [],
    skippedLibraries: skipped ?? [],
    cleanupUnsafeLibraries: cleanupUnsafeLibraries ?? [],
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
    mockBatchDirSizes.mockReset();
    mockBatchDirSizes.mockResolvedValue({});
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
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
    mockBatchDirSizes.mockResolvedValue({});
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
    mockBatchDirSizes.mockResolvedValue({});
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
  });

  it("übersprungener pfad → sizeBytes undefined, vorhandener pfad → gemessene größe", async () => {
    mockFindOrphans.mockResolvedValue([
      { appId: 12345, type: "compatdata", path: "/lib/compatdata/12345", library: "/lib" },
      { appId: 99999, type: "compatdata", path: "/lib/compatdata/99999_gone", library: "/lib" },
    ]);
    // batch_dir_sizes überspringt 99999_gone (NotFound) → kein map-eintrag
    mockBatchDirSizes.mockResolvedValue({ "/lib/compatdata/12345": 8192 });

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
    mockBatchDirSizes.mockResolvedValue({});
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
    mockBatchDirSizes.mockResolvedValue({ [entry.path]: 8192 });

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
    mockBatchDirSizes.mockResolvedValue({});
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
    mockBatchDirSizes.mockResolvedValue({});
    mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
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
