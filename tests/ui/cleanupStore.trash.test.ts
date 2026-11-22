// biome-ignore assist/source/organizeImports: mock-registrierung muss vor dem store-import laufen (T-01)
import {
  fakeScan,
  fakeTrashEntries,
  fakeTrashEntry,
  MOCK_TOKEN_TTL_MS,
  mockBatchDirSizes,
  mockCancelDelete,
  mockExecuteDelete,
  mockIsSteamRunning,
  mockListTrashEntries,
  mockPrepareDelete,
  resetCleanupMocks,
  seedTrashEntries,
  setClaimDir,
  STEAM_ROOT,
  TRASH_DIR,
  trashListing,
} from "../support/cleanupStoreMocks";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE_CLAIM_PREFIX } from "../../src/core/cleanup";
import { paths } from "../../src/core/paths";
import * as diagnostics from "../../src/ui/diagnostics";
import { formatBytes } from "../../src/ui/format";
import { setLocale, t } from "../../src/ui/i18n";
import { trashDeleteBlockedText } from "../../src/ui/stores/cleanupHelpers";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { deferred } from "../support/factories";

describe("cleanupStore papierkorb-scan & löschung", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
  });

  it("scanTrash lädt einträge mit größen und trennt unbekannte sowie unlesbare", async () => {
    const entry = fakeTrashEntry();
    seedTrashEntries([entry], { unknownNames: ["fremd"] });
    mockBatchDirSizes.mockResolvedValue({
      [entry.path]: { status: "measured", sizeBytes: 8192 },
    });
    useScanStore().result = fakeScan();
    const store = useCleanupStore();

    await store.scanTrash();
    expect(store.trash).toHaveLength(1);
    expect(store.trash[0]?.sizeBytes).toBe(8192);
    expect(store.trashUnknown).toEqual([`${TRASH_DIR}/fremd`]);
    expect(store.trashUnavailable).toBe(true);
    expect(store.trashDeleteBlocked).toBe(false);

    // unlesbarer papierkorb sperrt auch das löschen
    seedTrashEntries([], { error: new Error("unreadable: EACCES permission denied") });
    await store.scanTrash();
    expect(store.error).toBeTruthy();
    expect(store.trashLibraries[0]?.error).toBe("unreadable");
    expect(store.trashDeleteBlocked).toBe(true);
  });

  it("deleteTrashEntries zeigt größen-summary (bekannt, teilweise, nicht gemessen) und partial-prepare", async () => {
    useScanStore().result = fakeScan();
    const store = useCleanupStore();
    const measured = fakeTrashEntry({ sizeBytes: 4096 });
    const partial = fakeTrashEntry({
      path: `${TRASH_DIR}/compatdata_570_100`,
      name: "compatdata_570_100",
      appId: 570,
      trashedAt: 100,
    });

    await store.deleteTrashEntries([measured, partial]);
    expect(useConfirmStore().pending?.message).toContain(
      t("cleanup.partialSize", { size: formatBytes(4096) }),
    );
    useConfirmStore().cancel();

    await store.deleteTrashEntries([partial]);
    expect(useConfirmStore().pending?.message).toContain(t("common.notMeasured"));
    useConfirmStore().cancel();

    mockPrepareDelete.mockImplementationOnce(async () => {
      throw new Error("unreadable");
    });
    store.trash = [partial, measured];
    await store.deleteTrashEntries([partial, measured]);
    expect(store.error).toContain(partial.name);
    expect(useConfirmStore().pending?.message).toContain(
      "nicht vorbereitete Einträge (1) bleiben unverändert.",
    );
    expect(useConfirmStore().pending?.message).toContain(formatBytes(4096));

    mockListTrashEntries.mockResolvedValueOnce(trashListing([partial]));
    await useConfirmStore().confirm();
    expect(mockExecuteDelete).toHaveBeenCalledTimes(1);
    expect(store.trash).toEqual([partial]);
  });

  it("lehnt >32 einträge oder fehlendes scan-ergebnis ab und batcht emptyTrash", async () => {
    const scanStore = useScanStore();
    scanStore.result = null;
    const store = useCleanupStore();
    const entries = fakeTrashEntries(33);
    store.trash = [...entries];

    await store.deleteTrashEntries([entries[0] ?? fakeTrashEntry()]);
    expect(store.error).toContain(t("errors.noScanResult"));

    await store.deleteTrashEntries(entries);
    expect(store.error).toContain("33");
    expect(mockPrepareDelete).not.toHaveBeenCalled();

    scanStore.result = fakeScan();
    await store.emptyTrash();
    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(useConfirmStore().pending?.message).toContain(
      "je durchgang höchstens 32 einträge; rest im papierkorb: 1.",
    );
    mockListTrashEntries.mockResolvedValueOnce(trashListing(entries.slice(32)));
    await useConfirmStore().confirm();
    expect(store.trash).toEqual([entries[32]]);
  });

  it("A-06 / A-04: liest library-zähler nach löschung neu und bewahrt execute- plus rescan-fehler", async () => {
    const e1 = fakeTrashEntry({
      path: `${TRASH_DIR}/compatdata_1091500_100`,
      name: "compatdata_1091500_100",
    });
    const e2 = fakeTrashEntry({
      path: `${TRASH_DIR}/compatdata_570_100`,
      name: "compatdata_570_100",
      appId: 570,
    });
    mockListTrashEntries
      .mockResolvedValueOnce(trashListing([e1, e2]))
      .mockResolvedValueOnce(trashListing([]))
      .mockRejectedValueOnce(new Error("unreadable"));

    useScanStore().result = fakeScan();
    const store = useCleanupStore();
    await store.scanTrash();
    expect(store.trashLibraries[0]?.count).toBe(2);

    await store.deleteTrashEntries([e1, e2]);
    await useConfirmStore().confirm();
    expect(store.trashLibraries[0]?.count).toBe(0);

    // Teilerfolg + kaputter Rescan
    store.trash = [e1, e2];
    mockExecuteDelete
      .mockResolvedValueOnce({ deletedPath: e1.path })
      .mockRejectedValueOnce(new Error("unreadable"));
    await store.deleteTrashEntries([e1, e2]);
    await useConfirmStore().confirm();
    expect(store.trashError).toContain(e2.name);
    expect(store.trashError).toContain("nicht gelöschte Einträge (1)");
    expect(store.trashError).toContain(t("errors.kinds.unreadable"));
  });

  it("S-10: gibt vorbereitete trash-tokens bei abbruch und stale generation frei", async () => {
    useScanStore().result = fakeScan();
    const store = useCleanupStore();
    const e1 = fakeTrashEntry();
    await store.deleteTrashEntries([e1]);
    useConfirmStore().cancel();
    expect(mockCancelDelete).toHaveBeenCalledExactlyOnceWith(`token-${e1.path}`);

    mockCancelDelete.mockClear();
    mockPrepareDelete.mockImplementationOnce(async (req) => {
      store.resetForLibraryScan();
      return {
        token: `token-stale-${req.path}`,
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
        targetType: req.targetType,
        targetPath: req.path,
        consequences: [],
      };
    });
    await store.deleteTrashEntries([e1]);
    expect(mockCancelDelete).toHaveBeenCalledExactlyOnceWith(`token-stale-${e1.path}`);
  });

  it("sperrt löschen bei scan-fehler (auch während größenmessung), reiner löschfehler sperrt nicht (FR-4)", async () => {
    useScanStore().result = fakeScan();
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    seedTrashEntries([entry]);
    const sizeGate = deferred<Record<string, { status: "missing" }>>();
    mockBatchDirSizes.mockImplementationOnce(() => sizeGate.promise);

    // fehler während scan über zweite library erzwingen
    useScanStore().result = { ...fakeScan(), libraries: [STEAM_ROOT, "/lib2"] };
    seedTrashEntries([], { library: "/lib2", error: new Error("EACCES") });
    const scan = store.scanTrash();
    await vi.waitFor(() => expect(mockBatchDirSizes).toHaveBeenCalledTimes(1));
    await store.deleteTrashEntries([entry]);
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(store.trashError).toContain(trashDeleteBlockedText(true) ?? "");
    sizeGate.resolve({ [entry.path]: { status: "missing" } });
    await scan;

    // FR-1 sprachwechsel
    expect(trashDeleteBlockedText(store.trashDeleteBlocked)).toBe(t("cleanup.trashDeleteBlocked"));
    setLocale("en");
    expect(trashDeleteBlockedText(store.trashDeleteBlocked)).toBe(t("cleanup.trashDeleteBlocked"));
    setLocale("de");

    // reiner löschfehler sperrt nicht
    resetCleanupMocks();
    useScanStore().result = fakeScan();
    store.clearTrashState();
    store.trash = [entry];
    mockExecuteDelete.mockRejectedValueOnce(new Error("unreadable"));
    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();
    expect(store._trashScanError).toBeNull();
    expect(store.trashDeleteBlocked).toBe(false);
    await store.deleteTrashEntries([entry]);
    expect(useConfirmStore().pending).not.toBeNull();
    useConfirmStore().cancel();
  });

  it("write-may-have-applied löst claim-refresh aus (nicht bei laufendem steam/P8) und protokolliert (FR-2)", async () => {
    useScanStore().result = fakeScan();
    const store = useCleanupStore();
    const entry = fakeTrashEntry();
    store.trash = [entry];
    setClaimDir(paths.compatdataDir(STEAM_ROOT), `${DELETE_CLAIM_PREFIX}claim1`);
    const uncertainFailure = new Error("write-may-have-applied: partial");
    const logSpy = vi.spyOn(diagnostics, "logError");

    mockExecuteDelete.mockRejectedValueOnce(uncertainFailure);
    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();
    expect(store.incompleteDeletions).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Papierkorb-Eintrag löschen fehlgeschlagen"),
      uncertainFailure,
    );

    // P8: steam-check rejectet -> kein orphan-refresh, protokoll schreibt steam-fehler, löschfehler bleibt
    resetCleanupMocks();
    store.clearOrphanState();
    store.clearTrashState();
    store.trash = [entry];
    setClaimDir(paths.compatdataDir(STEAM_ROOT), `${DELETE_CLAIM_PREFIX}claim2`);
    mockExecuteDelete.mockRejectedValueOnce(uncertainFailure);
    mockIsSteamRunning.mockResolvedValueOnce(true); // laufendes Steam überspringt ebenfalls orphan-refresh
    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();
    expect(store.incompleteDeletions).toEqual([]);
    expect(store.trashError).toContain(entry.name);

    store.clearOrphanState();
    store.clearTrashState();
    store.trash = [entry];
    const steamFailure = new Error("steam-check-unavailable: /proc");
    mockExecuteDelete.mockRejectedValueOnce(uncertainFailure);
    mockIsSteamRunning.mockRejectedValueOnce(steamFailure);
    await store.deleteTrashEntries([entry]);
    await useConfirmStore().confirm();
    expect(store.incompleteDeletions).toEqual([]);
    expect(store.trashError).toContain(entry.name);
    expect(store.trashError).not.toContain(t("errors.codes.steamCheckUnavailable"));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Steam-Status nach Papierkorb-Löschung nicht prüfbar"),
      steamFailure,
    );
    logSpy.mockRestore();
  });
});
