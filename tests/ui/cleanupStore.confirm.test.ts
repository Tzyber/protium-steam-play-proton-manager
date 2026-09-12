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
    mockExecuteDelete.mockResolvedValue({ deletedPath: "" });
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
