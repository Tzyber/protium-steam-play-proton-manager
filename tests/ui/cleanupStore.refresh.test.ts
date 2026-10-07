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
  mockFindTrashEntries,
  mockIsSteamRunning,
  mockPrepareDelete,
  resetCleanupMocks,
} from "../support/cleanupStoreMocks";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "../../src/core/types";
import { formatError } from "../../src/ui/formatError";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { deferred, game as makeGame } from "../support/factories";

function fakeScanWithGames(gameIds: number[]): ScanResult {
  return { ...fakeScan(), games: gameIds.map((appId) => makeGame({ appId })) };
}

describe("cleanupStore, papierkorb-refresh nach dem löschen", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
  });

  it("compatdata löschen lädt den papierkorb neu und zeigt den verschobenen eintrag", async () => {
    // T-09: früher belegte nur `toHaveBeenCalled` den refresh. Jetzt hängt die
    // assertion am echten store-stand: der neu verschobene eintrag steht in der
    // papierkorb-liste, nicht nur ein mock-aufruf.
    const trashed = fakeTrashEntry({
      path: "/lib/steamapps/.protium-trash/compatdata_999999_1",
      name: "compatdata_999999_1",
      appId: 999999,
    });
    mockFindTrashEntries.mockResolvedValue({
      entries: [trashed],
      unknown: [],
      unreadable: [],
      libraries: [],
    });
    mockBatchDirSizes.mockResolvedValue({
      [trashed.path]: { status: "measured", sizeBytes: 4096 },
    });
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

    expect(store.trash).toEqual([{ ...trashed, sizeBytes: 4096 }]);
  });

  it("shadercache löschen lädt den papierkorb NICHT neu (hard delete)", async () => {
    // T-09: statt `not.toHaveBeenCalled` wird der vorbestand geprüft: ein
    // (fälschlicher) refresh würde ihn gegen die frisch gelieferte liste tauschen.
    const seeded = fakeTrashEntry();
    mockFindTrashEntries.mockResolvedValue({
      entries: [fakeTrashEntry({ path: "/frisch", name: "compatdata_1_2", appId: 1 })],
      unknown: [],
      unreadable: [],
      libraries: [],
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    store.trash = [seeded];

    await store.deleteOrphans([
      {
        appId: 888888,
        type: "shadercache",
        path: "/lib/steamapps/shadercache/888888",
        library: "/lib",
      },
    ]);
    await useConfirmStore().confirm();

    expect(store.trash).toEqual([seeded]);
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

  it("hängt den löschfehler an den fehler des internen orphan-rescans an", async () => {
    const failure = new Error("unreadable");
    mockExecuteDelete.mockRejectedValue(failure);
    mockIsSteamRunning.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const path = "/lib/steamapps/shadercache/888888";

    await store.deleteOrphans([{ appId: 888888, type: "shadercache", path, library: "/lib" }]);
    await useConfirmStore().confirm();

    expect(store.orphanError).toBe(
      `${t("errors.steamRunningCleanup")}; shadercache/${path}: ${formatError(failure)}`,
    );
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
    resetCleanupMocks();
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
      expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
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

describe("cleanupStore, orphan-scanfehler beim löschen", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
  });

  const kept = { appId: 1, type: "shadercache" as const, path: "/lib/sc/1", library: "/lib" };
  const failing = { appId: 2, type: "shadercache" as const, path: "/lib/sc/2", library: "/lib" };
  const sizeFailure = new Error("unreadable");
  const prepareFailure = new Error("path-missing");

  async function scanWithSizeFailure() {
    mockFindOrphans.mockResolvedValue([kept, failing]);
    mockBatchDirSizes.mockRejectedValueOnce(sizeFailure);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    await store.scanOrphans();
    const scanError = formatError(sizeFailure);
    expect(store.orphanError).toBe(scanError);
    return { store, scanError };
  }

  function failPrepareFor(path: string): void {
    mockPrepareDelete.mockImplementation(async (req) => {
      if (req.path === path) throw prepareFailure;
      return {
        token: `token-${req.path}`,
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
        targetType: req.targetType,
        targetPath: req.path,
        consequences: [],
      };
    });
  }

  it("sperrt das löschen nach einem scan-fehler, der fehler bleibt stehen", async () => {
    const { store, scanError } = await scanWithSizeFailure();

    expect(store.orphanDeleteBlocked("shadercache")).toBe(true);
    await store.deleteOrphans([kept]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(useConfirmStore().reserved).toBe(false);
    expect(store.orphanError).toBe(scanError);
  });

  it("ein löschfehler sperrt den nächsten versuch nicht und staut nicht auf", async () => {
    mockFindOrphans.mockResolvedValue([kept, failing]);
    useScanStore().result = fakeScan([]);
    const store = useCleanupStore();
    await store.scanOrphans();
    failPrepareFor(failing.path);
    const prepareError = `shadercache/2: ${formatError(prepareFailure)}`;

    await store.deleteOrphans([kept, failing]);
    useConfirmStore().cancel();
    expect(store.orphanError).toBe(prepareError);
    expect(store.orphanDeleteBlocked("shadercache")).toBe(false);

    await store.deleteOrphans([kept, failing]);
    useConfirmStore().cancel();
    expect(store.orphanError).toBe(prepareError);

    await store.deleteOrphans([kept]);
    useConfirmStore().cancel();
    expect(store.orphanError).toBeNull();
  });
});
