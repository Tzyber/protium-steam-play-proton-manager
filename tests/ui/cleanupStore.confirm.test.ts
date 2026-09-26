// T-01: die mock-preamble liegt in tests/support/cleanupStoreMocks.ts und MUSS
// vor dem ersten store-/modul-import geladen werden, sonst baut der modulgraph
// die echten ports auf, bevor vi.mock registriert ist. Die reihenfolge weicht
// davon ab, was biome als alphabetische import-gruppierung erzwingen wuerde.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor dem store-import laufen (T-01)
import {
  fakeScan,
  fakeTrashEntry,
  MOCK_TOKEN_TTL_MS,
  mockBatchDirSizes,
  mockExecuteDelete,
  mockFindOrphans,
  mockPrepareDelete,
  mockReadLocalConfig,
  resetCleanupMocks,
} from "../support/cleanupStoreMocks";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingDeleteInfo } from "../../src/core/ports";
import { setLocale } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useProtonStore } from "../../src/ui/stores/protonStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { deferred } from "../support/factories";

describe("cleanupStore, gemeinsame confirm-reservierung", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
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
      expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
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
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
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
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
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
    resetCleanupMocks();
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

    expect(store.error).toContain("Größe fehlt");
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

    expect(store.error).toContain("ungültig");
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

    expect(store.error).toContain("ungültig");
    expect(store.orphans.map((entry) => entry.sizeBytes)).toEqual([undefined, undefined]);
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
