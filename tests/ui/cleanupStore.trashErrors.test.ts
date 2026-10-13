// T-01: die mock-preamble liegt in tests/support/cleanupStoreMocks.ts und MUSS
// vor dem ersten store-/modul-import geladen werden, sonst baut der modulgraph
// die echten ports auf, bevor vi.mock registriert ist. Die reihenfolge weicht
// davon ab, was biome als alphabetische import-gruppierung erzwingen wuerde.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor dem store-import laufen (T-01)
import {
  fakeScan,
  fakeTrashEntries,
  fakeTrashEntry,
  mockBatchDirSizes,
  mockExecuteDelete,
  mockFindTrashEntries,
  mockPrepareDelete,
  resetCleanupMocks,
  TRASH_DIR,
  trashScan,
} from "../support/cleanupStoreMocks";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatError } from "../../src/ui/formatError";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { deferred } from "../support/factories";

// der identische beforeEach der drei abgespaltenen blöcke steht einmal hier.
beforeEach(() => {
  setActivePinia(createPinia());
  setLocale("de");
  resetCleanupMocks();
});

describe("cleanupStore zähler nach dem löschen (A-06)", () => {
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

describe("cleanupStore, rescan-fehler nach dem löschen (A-04)", () => {
  // der ersatz zählt die generation wie der echte scanTrash. ohne das
  // hochzählen gilt der callback als überholt und kehrt vor dem setzen zurück.
  function mockUnreadableRescan(store: ReturnType<typeof useCleanupStore>, message: string): void {
    vi.spyOn(store, "scanTrash").mockImplementation(async () => {
      store._trashScanGeneration += 1;
      store.setTrashError(message);
    });
  }

  it("behält den rescan-fehler, wenn das löschen selbst keinen fehler hatte", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    store.trash = [entry];
    const rescanError = t("cleanup.trashUnreadable", { paths: "/lib" });
    mockUnreadableRescan(store, rescanError);

    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();

    expect(mockPrepareDelete).toHaveBeenCalledTimes(1);
    expect(mockExecuteDelete).toHaveBeenCalledTimes(1);
    expect(store.trashError).toBe(rescanError);
  });

  it("führt execute-fehler und rescan-fehler zusammen", async () => {
    const kept = fakeTrashEntry();
    const failed = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_570_100",
      name: "compatdata_570_100",
      appId: 570,
    });
    mockExecuteDelete
      .mockResolvedValueOnce({ deletedPath: kept.path })
      .mockRejectedValueOnce(new Error("unreadable"));
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [kept, failed];
    const rescanError = t("cleanup.trashUnreadable", { paths: "/lib" });
    mockUnreadableRescan(store, rescanError);

    await store.deleteTrashEntries([kept, failed]);
    await useConfirmStore().confirm();

    const message = store.trashError ?? "";
    expect(message.startsWith(rescanError)).toBe(true);
    expect(message).toContain("nicht gelöschte Einträge (1)");
    expect(message).toContain("compatdata_570_100");
    expect(message).toContain(t("errors.kinds.unreadable"));
  });
});

describe("cleanupStore, papierkorb-scanfehler beim löschen", () => {
  async function scanWithUnreadableLibrary() {
    const entry = fakeTrashEntry();
    mockFindTrashEntries.mockResolvedValueOnce({
      entries: [entry],
      unknown: [],
      unreadable: ["/lib2"],
      libraries: [
        { library: "/lib", dir: TRASH_DIR, present: true, count: 1 },
        { library: "/lib2", dir: "", present: true, count: 0, error: "EACCES" },
      ],
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    await store.scanTrash();
    const scanError = t("cleanup.trashUnreadable", { paths: "/lib2" });
    expect(store.trashError).toBe(scanError);
    return { store, entry, scanError };
  }

  it("behält den scan-fehler nach einem abgebrochenen dialog", async () => {
    const { store, entry, scanError } = await scanWithUnreadableLibrary();

    await store.deleteTrashEntries([entry]);
    useConfirmStore().cancel();

    expect(store.trashError).toBe(scanError);
  });

  it("behält den scan-fehler bei einer zu großen auswahl", async () => {
    const { store, scanError } = await scanWithUnreadableLibrary();

    await store.deleteTrashEntries(fakeTrashEntries(33));

    expect(store.trashError).toBe(
      `${scanError}; ${t("errors.deleteBatchTooLarge", { n: 33, max: 32 })}`,
    );
  });

  it("übernimmt keinen löschfehler aus einem lauf während der größenmessung als scan-fehler", async () => {
    const entry = fakeTrashEntry();
    mockFindTrashEntries.mockResolvedValueOnce({
      entries: [entry],
      unknown: [],
      unreadable: ["/lib2"],
      libraries: [
        { library: "/lib", dir: TRASH_DIR, present: true, count: 1 },
        { library: "/lib2", dir: "", present: true, count: 0, error: "EACCES" },
      ],
    });
    const sizes = deferred<Awaited<ReturnType<typeof mockBatchDirSizes>>>();
    mockBatchDirSizes.mockImplementationOnce(() => sizes.promise);
    const prepareFailure = new Error("unreadable");
    mockPrepareDelete.mockRejectedValueOnce(prepareFailure);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const scanError = t("cleanup.trashUnreadable", { paths: "/lib2" });

    const scan = store.scanTrash();
    await vi.waitFor(() => expect(mockBatchDirSizes).toHaveBeenCalledTimes(1));
    await store.deleteTrashEntries([entry]);
    expect(store.trashError).toBe(
      `${scanError}; ${t("cleanup.trashPrepareError", { n: 1, errors: `${entry.name}: ${formatError(prepareFailure)}` })}`,
    );
    sizes.resolve({ [entry.path]: { status: "missing" } });
    await scan;

    await store.deleteTrashEntries([entry]);
    useConfirmStore().cancel();

    expect(store.trashError).toBe(scanError);
  });

  it("hängt einen unerwarteten folgefehler an den scan-fehler an", async () => {
    const { store, entry, scanError } = await scanWithUnreadableLibrary();
    const failure = new Error("unreadable");
    vi.spyOn(store, "scanTrash").mockRejectedValueOnce(failure);

    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();

    expect(store.trashError).toBe(
      `${scanError}; ${t("cleanup.trashExecuteError", { n: 1, errors: formatError(failure) })}`,
    );
  });

  it("hängt einen execute-fehler ohne rescan an den scan-fehler an", async () => {
    const { store, entry, scanError } = await scanWithUnreadableLibrary();
    const failure = new Error("unreadable");
    mockExecuteDelete.mockRejectedValueOnce(failure);

    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();

    expect(store.trashError).toBe(
      `${scanError}; ${t("cleanup.trashExecuteError", { n: 1, errors: `${entry.name}: ${formatError(failure)}` })}`,
    );
  });
});
