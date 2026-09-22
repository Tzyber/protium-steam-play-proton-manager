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
import { useScanStore } from "../../src/ui/stores/scanStore";
import { deferred, scanResult } from "../support/factories";

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

describe("cleanupStore steamOwnedPrefixes", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
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
    const currentError = "unreadable";
    mockFindOrphans.mockRejectedValueOnce(new Error(currentError));
    const currentScan = store.scanOrphans();
    await currentScan;
    expect(store.error).toContain("unlesbar");
    second.reject(new Error("alter scan-fehler"));
    await staleErrorScan;
    expect(store.error).toContain("unlesbar");
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
