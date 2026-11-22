// biome-ignore assist/source/organizeImports: mock-registrierung muss vor dem store-import laufen (T-01)
import {
  clearDirEntries,
  failVfsPath,
  fakeOrphanEntries,
  fakeScan,
  fakeScanWithGames,
  fakeTrashEntry,
  MOCK_TOKEN_TTL_MS,
  mockBatchDirSizes,
  mockCancelDelete,
  mockExecuteDelete,
  mockIsSteamRunning,
  mockPrepareDelete,
  resetCleanupMocks,
  seedTrashEntries,
  setOrphanDirs,
  STEAM_ROOT,
  TRASH_DIR,
} from "../support/cleanupStoreMocks";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingDeleteInfo } from "../../src/core/ports";
import { paths } from "../../src/core/paths";
import * as diagnostics from "../../src/ui/diagnostics";
import { formatError } from "../../src/ui/formatError";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useProtonStore } from "../../src/ui/stores/protonStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { customTool, deferred } from "../support/factories";

describe("cleanupStore orphan-löschung, confirm & batching", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
  });

  it("überspringt installierte spiele (S-05), blockiert compatdata bei unlesbaren shortcuts", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanWithGames([42]);
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 42, type: "compatdata", path: "/fake/42", library: STEAM_ROOT },
    ]);
    expect(store.error).toContain("inzwischen installiert");

    scanStore.result = fakeScan();
    failVfsPath(paths.userdataDir(STEAM_ROOT), new Error("EACCES"));
    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: STEAM_ROOT },
      { appId: 888888, type: "shadercache", path: "/fake/shader", library: STEAM_ROOT },
    ]);
    expect(store.error).toContain("nicht lesbar");
    expect(store.error).not.toContain("888888");
  });

  it("reserviert confirm gemeinsam mit proton.remove und räumt bei cancel / ask=false", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const proton = useProtonStore();
    const store = useCleanupStore();
    const confirm = useConfirmStore();
    const held = confirm.reserve();
    expect(held).not.toBeNull();

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: STEAM_ROOT },
    ]);
    await store.deleteTrashEntries([fakeTrashEntry()]);
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    if (held !== null) confirm.release(held);

    // parallele GE-Vorbereitung blockiert orphan-löschung
    const pendingGe = deferred<PendingDeleteInfo>();
    mockPrepareDelete.mockImplementationOnce(() => pendingGe.promise);
    const geRemove = proton.remove(customTool("GE-Proton9-27", { sizeBytes: 1000 }));
    await vi.waitFor(() => expect(mockPrepareDelete).toHaveBeenCalledTimes(1));

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: STEAM_ROOT },
    ]);
    expect(mockPrepareDelete).toHaveBeenCalledTimes(1);
    pendingGe.resolve({
      token: "ge-token",
      expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
      targetType: "compatTool",
      targetPath: `${STEAM_ROOT}/compatibilitytools.d/GE-Proton9-27`,
      consequences: [],
    });
    await geRemove;
    confirm.cancel();

    mockCancelDelete.mockClear();
    vi.spyOn(confirm, "ask").mockReturnValueOnce(false);
    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: STEAM_ROOT },
    ]);
    expect(mockCancelDelete).toHaveBeenCalledExactlyOnceWith("token-/fake/wine");
    expect(store.deleting.size).toBe(0);
    expect(confirm.reserved).toBe(false);
  });

  it("compatdata-löschen lädt trash neu; shadercache lädt trash NICHT neu", async () => {
    const trashed = fakeTrashEntry({
      path: `${TRASH_DIR}/compatdata_999999_1`,
      name: "compatdata_999999_1",
      appId: 999999,
      trashedAt: 1,
    });
    seedTrashEntries([trashed]);
    mockBatchDirSizes.mockResolvedValue({
      [trashed.path]: { status: "measured", sizeBytes: 4096 },
    });
    useScanStore().result = fakeScan();
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/lib/compatdata/999999", library: STEAM_ROOT },
    ]);
    expect(useConfirmStore().pending?.title).toBe("1 verwaisten Eintrag entfernen?");
    await useConfirmStore().confirm();
    expect(store.trash).toEqual([{ ...trashed, sizeBytes: 4096 }]);

    const seeded = fakeTrashEntry();
    store.trash = [seeded];
    await store.deleteOrphans([
      { appId: 888888, type: "shadercache", path: "/lib/shadercache/888888", library: STEAM_ROOT },
    ]);
    await useConfirmStore().confirm();
    expect(store.trash).toEqual([seeded]);
  });

  it("setzt confirmLabel je aktion (moveToTrash vs. delete) und nennt spielnamen", async () => {
    useScanStore().result = fakeScan();
    const store = useCleanupStore();
    store.orphanNames = { "/fake/wine": "Portal 2" };
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [
        {
          path: req.path,
          action: req.path.includes("shader") ? ("permanentDelete" as const) : ("trash" as const),
          description: "x",
          affectedAppIds: [999999],
        },
      ],
    }));

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: STEAM_ROOT },
    ]);
    expect(useConfirmStore().pending?.confirmLabel).toBe(t("cleanup.moveToTrash"));
    expect(useConfirmStore().pending?.message).toContain("Portal 2");
    useConfirmStore().cancel();

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: STEAM_ROOT },
      { appId: 999999, type: "shadercache", path: "/fake/shader", library: STEAM_ROOT },
    ]);
    expect(useConfirmStore().pending?.confirmLabel).toBe(t("common.delete"));
    useConfirmStore().cancel();
  });

  it("lehnt >32 einträge vor allen gates ab und verarbeitet 32/33/70 im batch", async () => {
    const scanStore = useScanStore();
    scanStore.result = null;
    const store = useCleanupStore();

    await store.deleteOrphans(fakeOrphanEntries(33));
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockIsSteamRunning).not.toHaveBeenCalled();
    expect(store.error).toContain("33");

    scanStore.result = fakeScan();
    await store.deleteOrphansAll(fakeOrphanEntries(70));
    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(useConfirmStore().pending?.message).toContain(
      "je durchgang höchstens 32 einträge; danach verbleiben: 38.",
    );
    await useConfirmStore().confirm();
    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);

    setLocale("en");
    await store.deleteOrphansAll(fakeOrphanEntries(33));
    expect(useConfirmStore().pending?.message).toContain(
      "at most 32 entries per pass; remaining afterwards: 1.",
    );
    useConfirmStore().cancel();
  });

  it("bewahrt execute-fehler über rescan und staut vorbereitungsfehler nicht auf", async () => {
    useScanStore().result = fakeScan();
    const store = useCleanupStore();
    setOrphanDirs([
      { appId: 1, type: "shadercache" },
      { appId: 2, type: "shadercache" },
    ]);
    await store.scanOrphans();

    const p1 = paths.shadercachePath(STEAM_ROOT, "1");
    const p2 = paths.shadercachePath(STEAM_ROOT, "2");
    mockPrepareDelete.mockImplementation(async (req) => {
      if (req.path === p2) throw new Error("path-missing");
      return {
        token: `token-${req.path}`,
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
        targetType: req.targetType,
        targetPath: req.path,
        consequences: [],
      };
    });
    await store.deleteOrphans([
      { appId: 1, type: "shadercache", path: p1, library: STEAM_ROOT },
      { appId: 2, type: "shadercache", path: p2, library: STEAM_ROOT },
    ]);
    useConfirmStore().cancel();
    expect(store.deleting.size).toBe(0);
    expect(store.orphanError).toContain("shadercache/2");

    // nächster sauberer lauf ersetzt fehler
    await store.deleteOrphans([{ appId: 1, type: "shadercache", path: p1, library: STEAM_ROOT }]);
    expect(store.orphanError).toBeNull();
    mockExecuteDelete.mockRejectedValueOnce(new Error("unreadable"));
    mockIsSteamRunning.mockResolvedValueOnce(true); // rescan schlägt nach execute mit steamRunning fehl
    await useConfirmStore().confirm();
    expect(store.orphanError).toBe(
      `${t("errors.steamRunningCleanup")}; shadercache/${p1}: ${formatError(new Error("unreadable"))}`,
    );
  });

  it("verwirft stale prolog/callback-fehler und nutzt pfadbasierte keys", async () => {
    useScanStore().result = fakeScan();
    const store = useCleanupStore();
    const logSpy = vi.spyOn(diagnostics, "logError");
    mockIsSteamRunning.mockRejectedValueOnce(new Error("steam-check-unavailable: /proc"));
    await expect(
      store.deleteOrphans([
        { appId: 1, type: "shadercache", path: "/fake/1", library: STEAM_ROOT },
      ]),
    ).resolves.toBeUndefined();
    expect(store.orphanError).toBe(t("errors.codes.steamCheckUnavailable"));
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();

    // stale execute callback nach neuem scan überschreibt aktuellen scan-fehler nicht
    const execGate = deferred<{ deletedPath: string }>();
    mockExecuteDelete.mockImplementationOnce(() => execGate.promise);
    await store.deleteOrphans([
      { appId: 1, type: "shadercache", path: "/fake/1", library: STEAM_ROOT },
    ]);
    const pendingConfirm = useConfirmStore().confirm();
    await vi.waitFor(() => expect(mockExecuteDelete).toHaveBeenCalledTimes(1));

    clearDirEntries(paths.shadercacheDir(STEAM_ROOT));
    failVfsPath(paths.compatdataDir(STEAM_ROOT), new Error("unreadable"));
    await store.scanOrphans();
    store.setOrphanScanError("unlesbarer scan");
    execGate.reject(new Error("alter fehler"));
    await pendingConfirm;
    expect(store.error).toContain("unlesbarer scan");
    expect(store.error).not.toContain("alter fehler");
    expect(store.deleting.size).toBe(0);
  });
});
