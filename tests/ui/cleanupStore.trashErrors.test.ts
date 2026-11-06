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
  mockIsSteamRunning,
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
  const blockedText = () => t("cleanup.trashDeleteBlocked");

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

  /** Setzt den scan-fehler erst nach dem Lösch-Gate: nur so bleibt der löschpfad
   *  offen und der fehlerzweig lässt sich prüfen (ein paralleler papierkorb-scan
   *  kann den fakt jederzeit nachliefern). */
  function setScanErrorDuringPrepare(
    store: ReturnType<typeof useCleanupStore>,
    message: string,
  ): void {
    mockPrepareDelete.mockImplementationOnce(async (req) => {
      store.setTrashScanError(message);
      return {
        token: `token-${req.path}`,
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
        targetType: req.targetType,
        targetPath: req.path,
        consequences: [],
      };
    });
  }

  it("sperrt das löschen bei einem scan-fehler: kein prepare, kein dialog", async () => {
    const { store, entry, scanError } = await scanWithUnreadableLibrary();
    expect(store.trashDeleteBlockedText).toBe(blockedText());

    await store.deleteTrashEntries([entry]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(useConfirmStore().pending).toBeNull();
    expect(useConfirmStore().reserved).toBe(false);
    // der scan-fehler bleibt erhalten, der sperrgrund kommt dazu
    expect(store.trashError).toBe(`${scanError}; ${blockedText()}`);
    expect(store.trash).toEqual([entry]);
  });

  it("behält den scan-fehler bei einer zu großen auswahl", async () => {
    const { store, scanError } = await scanWithUnreadableLibrary();

    await store.deleteTrashEntries(fakeTrashEntries(33));

    // das 32er-gate läuft vor der sperre und nennt keinen gate-text
    expect(store.trashError).toBe(
      `${scanError}; ${t("errors.deleteBatchTooLarge", { n: 33, max: 32 })}`,
    );
  });

  it("sperrt das löschen schon während der größenmessung, ohne den scan-fakt zu überschreiben", async () => {
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
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const scanError = t("cleanup.trashUnreadable", { paths: "/lib2" });

    const scan = store.scanTrash();
    await vi.waitFor(() => expect(mockBatchDirSizes).toHaveBeenCalledTimes(1));
    await store.deleteTrashEntries([entry]);
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(store._trashScanError).toBe(scanError);
    expect(store.trashError).toBe(`${scanError}; ${blockedText()}`);

    sizes.resolve({ [entry.path]: { status: "missing" } });
    await scan;

    // der scan-fakt bleibt der scan-fehler, der löschversuch hat ihn nicht verdrängt
    expect(store._trashScanError).toBe(scanError);
    expect(store.trash).toEqual([entry]);
  });

  it("führt einen nach dem gate gesetzten scan-fehler mit dem löschfehler zusammen", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    store.trash = [entry];
    const scanError = t("cleanup.trashUnreadable", { paths: "/lib" });
    const failure = new Error("unreadable");
    setScanErrorDuringPrepare(store, scanError);
    mockExecuteDelete.mockRejectedValueOnce(failure);

    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();

    expect(store.trashError).toBe(
      `${scanError}; ${t("cleanup.trashExecuteError", {
        n: 1,
        errors: `${entry.name}: ${formatError(failure)}`,
      })}`,
    );
  });

  it("hängt einen unerwarteten folgefehler an den nach dem gate gesetzten scan-fehler an", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    store.trash = [entry];
    const scanError = t("cleanup.trashUnreadable", { paths: "/lib" });
    const failure = new Error("unreadable");
    setScanErrorDuringPrepare(store, scanError);
    vi.spyOn(store, "scanTrash").mockRejectedValueOnce(failure);

    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();

    expect(store.trashError).toBe(
      `${scanError}; ${t("cleanup.trashExecuteError", { n: 1, errors: formatError(failure) })}`,
    );
  });

  it("ein reiner löschfehler ist kein scan-fakt und sperrt nicht", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    store.trash = [entry];
    const failure = new Error("write-may-have-applied: claim may be gone or partial");
    mockExecuteDelete.mockRejectedValueOnce(failure);
    // eine unsichere mutation kann einen claim-rest hinterlassen; der refresh
    // macht ihn sichtbar und sperrt den papierkorb, statt auf einen
    // library-rescan zu warten (FR-4, Audit 5.1).
    const orphanRefresh = vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);

    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();

    expect(orphanRefresh).toHaveBeenCalledTimes(1);
    expect(store.trashError).toContain(entry.name);
    expect(store._trashScanError).toBeNull();
    expect(store.trashUnavailable).toBe(false);
    expect(store.trashDeleteBlockedText).toBeNull();

    // ein reiner löschfehler sperrt nicht: der erneute versuch geht bis zum dialog
    await store.deleteTrashEntries([entry]);
    expect(useConfirmStore().pending).not.toBeNull();
    useConfirmStore().cancel();
  });

  it("ein fehler vor der mutation löst keinen claim-refresh aus", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    store.trash = [entry];
    mockExecuteDelete.mockRejectedValueOnce(new Error("unreadable"));
    const orphanRefresh = vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);

    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();

    expect(orphanRefresh).not.toHaveBeenCalled();
  });

  it("kein claim-refresh bei laufendem steam", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    store.trash = [entry];
    mockExecuteDelete.mockRejectedValueOnce(
      new Error("write-may-have-applied: claim may be gone or partial"),
    );
    mockIsSteamRunning.mockResolvedValueOnce(true);
    const orphanRefresh = vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);

    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();

    // der orphan-scan würde bei laufendem steam den steam-fehler in die
    // orphan-panels schreiben; der papierkorb bleibt trotzdem gesperrt.
    expect(orphanRefresh).not.toHaveBeenCalled();
    expect(store.trashError).toContain(entry.name);
  });

  it("kein claim-refresh bei nicht prüfbarem steam-status, löschfehler bleibt (P8)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    store.trash = [entry];
    const failure = new Error("write-may-have-applied: claim may be gone or partial");
    mockExecuteDelete.mockRejectedValueOnce(failure);
    // P8: der check rejectet mit steam-check-unavailable, statt still false zu
    // liefern. Der papierkorb ist von der sperre ausgenommen, der reject darf
    // den lauf deshalb nicht über onError verlassen.
    mockIsSteamRunning.mockRejectedValueOnce(new Error("steam-check-unavailable: /proc"));
    const orphanRefresh = vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);

    await expect(store.deleteTrashEntries([entry])).resolves.toBeUndefined();
    await useConfirmStore().confirm();

    // ohne belegbaren steam-status bleibt der orphan-refresh aus (fail-closed)
    expect(orphanRefresh).not.toHaveBeenCalled();
    // der löschfehler steht da, der übersetzte steam-text nicht
    const message = store.trashError ?? "";
    expect(message).toContain(entry.name);
    expect(message).toContain(formatError(failure));
    expect(message).not.toContain(t("errors.codes.steamCheckUnavailable"));
    expect(message).not.toContain("/proc");
    // der reject ist kein scan-fakt geworden
    expect(store._trashScanError).toBeNull();
  });

  it("nach teilerfolg läuft der trash-rescan auch bei nicht prüfbarem steam-status (P8)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const ok = fakeTrashEntry();
    const failed = fakeTrashEntry({
      path: `${TRASH_DIR}/compatdata_570_100`,
      name: "compatdata_570_100",
      appId: 570,
    });
    store.trash = [ok, failed];
    mockExecuteDelete.mockResolvedValueOnce({ deletedPath: ok.path });
    mockExecuteDelete.mockRejectedValueOnce(
      new Error("write-may-have-applied: claim may be gone or partial"),
    );
    mockIsSteamRunning.mockRejectedValueOnce(new Error("steam-check-unavailable: /proc"));
    // der reale rescan zählt die generation hoch; ein spy ohne generation
    // würde den fehlertext-zweig früh verlassen.
    mockFindTrashEntries.mockResolvedValueOnce(trashScan([failed]));
    const orphanRefresh = vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);

    await store.deleteTrashEntries([ok, failed]);
    await useConfirmStore().confirm();

    // reject überspringt nur den orphan-refresh, nicht den trash-rescan
    expect(orphanRefresh).not.toHaveBeenCalled();
    expect(mockFindTrashEntries).toHaveBeenCalledTimes(1);
    expect(store.trash).toEqual([failed]);
    expect(store.trashError).toContain(failed.name);
    expect(store.trashError).not.toContain(t("errors.codes.steamCheckUnavailable"));
  });
});
