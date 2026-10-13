// T-01: die mock-preamble liegt in tests/support/cleanupStoreMocks.ts und MUSS
// vor dem ersten store-/modul-import geladen werden, sonst baut der modulgraph
// die echten ports auf, bevor vi.mock registriert ist. Die reihenfolge weicht
// davon ab, was biome als alphabetische import-gruppierung erzwingen wuerde.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor dem store-import laufen (T-01)
import {
  fakeScan,
  fakeTrashEntries,
  fakeTrashEntry,
  MOCK_TOKEN_TTL_MS,
  mockBatchDirSizes,
  mockExecuteDelete,
  mockFindTrashEntries,
  mockPrepareDelete,
  resetCleanupMocks,
  trashScan,
} from "../support/cleanupStoreMocks";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatBytes } from "../../src/ui/format";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useScanStore } from "../../src/ui/stores/scanStore";

describe("cleanupStore, trash", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
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
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
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
    // nach dem löschen liest der store neu: e2 blieb liegen (prepare-fehler).
    mockFindTrashEntries.mockResolvedValue(trashScan([e2]));
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

  it("bricht ohne scan-ergebnis fail-closed ab statt mit leerem steamRoot zu arbeiten (N-7)", async () => {
    const scanStore = useScanStore();
    scanStore.result = null;
    const store = useCleanupStore();
    const existing = fakeTrashEntry({ path: "/existing/trash-entry" });
    store.trash = [existing];

    await store.deleteTrashEntries([fakeTrashEntry()]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(useConfirmStore().pending).toBeNull();
    expect(useConfirmStore().reserved).toBe(false);
    expect(store.trash).toEqual([existing]);
    expect(store.error).toContain(t("errors.noScanResult"));
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
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
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
    mockFindTrashEntries.mockResolvedValue(trashScan(entries.slice(32)));
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
    mockFindTrashEntries.mockResolvedValue(trashScan(entries.slice(32)));
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
    // nach dem löschen liest der store neu: e2 blieb liegen (execute-fehler).
    mockFindTrashEntries.mockResolvedValue(trashScan([e2]));
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
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
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

    const message = store.error ?? "";
    expect(message.match(/nicht vorbereitete Einträge \(1\)/g)).toEqual([
      "nicht vorbereitete Einträge (1)",
    ]);
    expect(message).toContain("nicht gelöschte Einträge (1)");
    expect(message).toContain("unlesbar");
  });
});
