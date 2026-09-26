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
  mockFindIncompleteDeletions,
  mockFindOrphans,
  mockFindSteamOwnedPrefixes,
  mockFindTrashEntries,
  mockPrepareDelete,
  resetCleanupMocks,
} from "../support/cleanupStoreMocks";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { findOrphans } from "../../src/core/cleanup";
import type { findTrashEntries, TrashEntry, TrashLibraryStatus } from "../../src/core/trash";
import { formatBytes } from "../../src/ui/format";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { deferred } from "../support/factories";

const TRASH_DIR = "/lib/steamapps/.protium-trash";

/** Papierkorb-stand für `findTrashEntries`. Der store liest den papierkorb seit
 *  A-06 nach jeder mutation neu, deshalb beschreibt der mock in diesen tests den
 *  zustand NACH dem löschen (die einträge, die noch liegen). */
function trashScan(
  entries: TrashEntry[],
  count = entries.length,
): {
  entries: TrashEntry[];
  unknown: string[];
  unreadable: string[];
  libraries: TrashLibraryStatus[];
} {
  return {
    entries,
    unknown: [],
    unreadable: [],
    libraries: [{ library: "/lib", dir: TRASH_DIR, present: true, count }],
  };
}

describe("cleanupStore steamOwnedPrefixes", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
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
    resetCleanupMocks();
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

    expect(store.error).toContain("nicht vorbereitete Einträge (1)");
    expect(store.error).toContain("nicht gelöschte Einträge (1)");
    expect(store.error).toContain("unlesbar");
    expect(store.error).toContain("unlesbar");
  });
});

describe("cleanupStore zähler nach dem löschen (A-06)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
  });

  const secondEntry = () =>
    fakeTrashEntry({
      path: `${TRASH_DIR}/compatdata_570_100`,
      name: "compatdata_570_100",
      appId: 570,
    });

  it("liest den stand je library nach einer löschung neu", async () => {
    const e1 = fakeTrashEntry();
    const e2 = secondEntry();
    mockFindTrashEntries.mockResolvedValueOnce(trashScan([e1, e2]));
    mockFindTrashEntries.mockResolvedValueOnce(trashScan([]));

    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    await store.scanTrash();
    expect(store.trashLibraries[0]?.count).toBe(2);

    store.trash = [e1, e2];
    await store.deleteTrashEntries([e1, e2]);
    await useConfirmStore().confirm();

    expect(store.trash).toEqual([]);
    // A-06: ohne neuen stand bleibt der zähler auf dem wert von vor der
    // löschung stehen, obwohl der papierkorb leer ist.
    expect(store.trashLibraries[0]?.count).toBe(0);
    expect(mockFindTrashEntries).toHaveBeenCalledTimes(2);
  });

  it("verschluckt löschfehler nicht durch den rescan", async () => {
    // mockRejectedValueOnce trifft den ersten aufruf, also den ersten eintrag.
    const e1 = fakeTrashEntry({
      path: `${TRASH_DIR}/compatdata_1091500_100`,
      name: "compatdata_1091500_100",
    });
    const e2 = secondEntry();
    mockFindTrashEntries.mockResolvedValue(trashScan([e2]));
    mockExecuteDelete.mockRejectedValueOnce(new Error("unreadable: EACCES"));
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [e1, e2];

    await store.deleteTrashEntries([e1, e2]);
    await useConfirmStore().confirm();

    // der rescan räumt trashError; die fehlermeldung muss danach wieder gesetzt
    // werden (reihenfolge wie in deleteOrphans: erst refreshen, dann melden).
    expect(store.error).toContain("compatdata_1091500_100");
    expect(store.error).toContain("unlesbar");
  });
});
