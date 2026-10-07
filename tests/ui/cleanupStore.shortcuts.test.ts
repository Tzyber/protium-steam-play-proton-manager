// T-01: die mock-preamble liegt in tests/support/cleanupStoreMocks.ts und MUSS
// vor dem ersten store-/modul-import geladen werden, sonst baut der modulgraph
// die echten ports auf, bevor vi.mock registriert ist. Die reihenfolge weicht
// davon ab, was biome als alphabetische import-gruppierung erzwingen wuerde.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor dem store-import laufen (T-01)
import {
  fakeOrphanEntries,
  fakeOrphanEntry,
  fakeScan,
  MOCK_TOKEN_TTL_MS,
  mockExecuteDelete,
  mockFindOrphans,
  mockIsSteamRunning,
  mockPrepareDelete,
  mockReadAllShortcutAppIds,
  resetCleanupMocks,
} from "../support/cleanupStoreMocks";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "../../src/core/types";
import * as diagnostics from "../../src/ui/diagnostics";
import { formatError } from "../../src/ui/formatError";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { deferred, game as makeGame } from "../support/factories";

function fakeScanWithGames(gameIds: number[]): ScanResult {
  return { ...fakeScan(), games: gameIds.map((appId) => makeGame({ appId })) };
}

describe("cleanupStore, S-05 + shortcuts", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
  });

  it("S-05: deleteOrphans überspringt einträge deren appId inzwischen installiert ist", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanWithGames([42]); // game 42 is installed
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 42, type: "compatdata", path: "/fake/42", library: "/lib" },
    ]);

    expect(store.error).toContain("inzwischen installiert");
  });

  it("deleteOrphans überspringt shortcut-appId wenn vom parser erkannt", async () => {
    mockReadAllShortcutAppIds.mockResolvedValue({
      status: "ok",
      ids: new Set([3641016077]),
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 3641016077, type: "compatdata", path: "/fake/sc", library: "/lib" },
    ]);

    expect(store.error).toContain("inzwischen installiert");
  });

  it("deleteOrphans blockiert compatdata wenn shortcuts.vdf unreadable", async () => {
    mockReadAllShortcutAppIds.mockResolvedValue({
      status: "unreadable",
      paths: ["/home/u/.steam/userdata/123/config/shortcuts.vdf"],
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
      { appId: 888888, type: "shadercache", path: "/fake/shader", library: "/lib" },
    ]);

    expect(store.error).toContain("nicht lesbar"); // wine-prefix blocked
    expect(store.error).not.toContain("888888"); // shadercache NOT blocked
  });

  it("scanOrphans blockiert compatdata aber erlaubt shadercache bei unlesbarem userdata", async () => {
    mockReadAllShortcutAppIds.mockResolvedValue({
      status: "unreadable",
      paths: [],
      detail: "EACCES: permission denied",
    });
    mockFindOrphans.mockResolvedValue([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
      { appId: 888888, type: "shadercache", path: "/fake/shader", library: "/lib" },
    ]);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.shortcutUnreadable).toBe(true);
    expect(store.error).toContain("Wine-Prefix-Bereinigung deaktiviert");
    expect(store.orphans).toHaveLength(1);
    expect(store.orphans[0]).toMatchObject({ appId: 888888, type: "shadercache" });
  });

  it("shortcutUnreadable allein sperrt den papierkorb nicht", () => {
    const store = useCleanupStore();
    store.shortcutUnreadable = true;

    expect(store.orphanError).toBeNull();
    expect(store.trashError).toBeNull();
    expect(store.trashUnavailable).toBe(false);
    expect(store.prefixUnavailable).toBe(true);
    expect(store.error).toContain(t("errors.shortcutsUnreadable"));
  });

  it("Policy: unlesbares shortcuts.vdf → compatdata fail-closed, shadercache regenerierbar", async () => {
    mockReadAllShortcutAppIds.mockResolvedValue({
      status: "unreadable",
      paths: ["/home/u/.steam/userdata/123/config/shortcuts.vdf"],
    });
    mockFindOrphans.mockResolvedValue([
      { appId: 111111, type: "compatdata", path: "/lib/compatdata/111111", library: "/lib" },
      { appId: 222222, type: "shadercache", path: "/lib/shadercache/222222", library: "/lib" },
    ]);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.orphans).toHaveLength(1);
    expect(store.orphans.some((o) => o.type === "compatdata")).toBe(false);
    expect(store.orphans.some((o) => o.type === "shadercache")).toBe(true);
    expect(store.error).toMatch(/Wine-Prefix-Bereinigung deaktiviert/i);
  });

  it("deleteOrphans blockiert ohne scan-ergebnis (fail-closed)", async () => {
    const scanStore = useScanStore();
    scanStore.result = null;
    const store = useCleanupStore();

    await store.deleteOrphans([{ appId: 1, type: "compatdata", path: "/fake", library: "/lib" }]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(store.error).toContain("scan-ergebnis");
    expect(store.orphans).toEqual([]);
  });

  it("lehnt mehr als 32 orphan-einträge vor allen gates ab", async () => {
    const scanStore = useScanStore();
    scanStore.result = null;
    const store = useCleanupStore();
    const existing = fakeOrphanEntry(0);
    store.orphans = [existing];
    store.blockedBySkipped = true;

    await store.deleteOrphans(Array.from({ length: 33 }, (_, index) => fakeOrphanEntry(index + 1)));

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(mockReadAllShortcutAppIds).not.toHaveBeenCalled();
    expect(mockIsSteamRunning).not.toHaveBeenCalled();
    expect(useConfirmStore().pending).toBeNull();
    expect(useConfirmStore().reserved).toBe(false);
    expect(store.deleting.size).toBe(0);
    expect(store.orphans).toEqual([existing]);
    expect(store.error).toContain("33");
    expect(store.error).toContain("32");
  });

  it("bereitet und führt exakt 32 orphan-einträge in einem dialog aus", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockFindOrphans.mockResolvedValue([]);
    const store = useCleanupStore();
    const entries = Array.from({ length: 32 }, (_, index) => fakeOrphanEntry(index));
    store.orphans = [...entries];

    await store.deleteOrphans(entries);

    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(useConfirmStore().pending?.title).toContain("32");
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
    expect(store.deleting.size).toBe(0);
  });

  it("setzt bei reinen papierkorb-verschiebungen den knopf auf verschieben", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [
        {
          path: req.path,
          action: "trash" as const,
          description: "Prefix in den Papierkorb verschieben",
          affectedAppIds: [999999],
        },
      ],
    }));
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);

    expect(useConfirmStore().pending?.confirmLabel).toBe(t("cleanup.moveToTrash"));
  });

  it("setzt bei endgültigem löschen den knopf auf löschen", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [
        {
          path: req.path,
          action: "permanentDelete" as const,
          description: "Shader-Cache dauerhaft löschen",
          affectedAppIds: [999999],
        },
      ],
    }));
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 999999, type: "shadercache", path: "/fake/shader", library: "/lib" },
    ]);

    expect(useConfirmStore().pending?.confirmLabel).toBe(t("common.delete"));
  });

  it("setzt den knopf auf löschen sobald ein eintrag endgültig gelöscht wird", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [
        {
          path: req.path,
          action: req.path === "/fake/shader" ? ("permanentDelete" as const) : ("trash" as const),
          description: "gemischt",
          affectedAppIds: [999999],
        },
      ],
    }));
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
      { appId: 999999, type: "shadercache", path: "/fake/shader", library: "/lib" },
    ]);

    expect(useConfirmStore().pending?.confirmLabel).toBe(t("common.delete"));
  });

  it("nennt im orphan-dialog den spielnamen aus orphanNames", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockPrepareDelete.mockImplementation(async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [
        {
          path: req.path,
          action: "trash" as const,
          description: "Prefix in den Papierkorb verschieben",
          affectedAppIds: [999999],
        },
      ],
    }));
    const store = useCleanupStore();
    store.orphanNames = { "/fake/wine": "Portal 2" };

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: "/fake/wine", library: "/lib" },
    ]);

    expect(useConfirmStore().pending?.message).toContain("Portal 2");
  });

  it("deleteOrphansAll verarbeitet nur die ersten 32 einträge und nennt den rest", async () => {
    const entries = fakeOrphanEntries(33);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockFindOrphans.mockResolvedValue([]);
    const store = useCleanupStore();
    store.orphans = [...entries];

    await store.deleteOrphansAll(entries);

    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(mockPrepareDelete).not.toHaveBeenCalledWith({
      targetType: "orphan",
      path: entries[32]?.path,
      steamRoot: "/home/u/.steam",
    });
    expect(useConfirmStore().pending?.title).toContain("32");
    expect(useConfirmStore().pending?.message).toContain(
      "je durchgang höchstens 32 einträge; danach verbleiben: 1.",
    );
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
  });

  it("deleteOrphansAll nennt grenze und rest auch bei deutlich mehr als 32 einträgen", async () => {
    const entries = fakeOrphanEntries(70);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockFindOrphans.mockResolvedValue([]);
    const store = useCleanupStore();
    store.orphans = [...entries];

    await store.deleteOrphansAll(entries);

    expect(mockPrepareDelete).toHaveBeenCalledTimes(32);
    expect(useConfirmStore().pending?.message).toContain(
      "je durchgang höchstens 32 einträge; danach verbleiben: 38.",
    );
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
  });

  it("deleteOrphansAll mit genau 32 einträgen nennt keinen rest", async () => {
    const entries = fakeOrphanEntries(32);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockFindOrphans.mockResolvedValue([]);
    const store = useCleanupStore();
    store.orphans = [...entries];

    await store.deleteOrphansAll(entries);

    expect(useConfirmStore().pending?.title).toContain("32");
    expect(useConfirmStore().pending?.message).not.toContain("danach verbleiben");
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(32);
  });

  it("deleteOrphansAll meldet die grenze auch auf englisch", async () => {
    setLocale("en");
    const entries = fakeOrphanEntries(33);
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    mockFindOrphans.mockResolvedValue([]);
    const store = useCleanupStore();
    store.orphans = [...entries];

    await store.deleteOrphansAll(entries);

    expect(useConfirmStore().pending?.title).toContain("32");
    expect(useConfirmStore().pending?.message).toContain(
      "at most 32 entries per pass; remaining afterwards: 1.",
    );
  });

  it("deleteOrphans setzt orphanError wenn der prolog wirft, ohne die promise abzulehnen", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const failure = new Error("handler-unavailable");
    mockReadAllShortcutAppIds.mockRejectedValueOnce(failure);

    await expect(
      store.deleteOrphans([
        { appId: 1, type: "shadercache", path: "/fake/shader", library: "/lib" },
      ]),
    ).resolves.toBeUndefined();

    expect(store.orphanError).toBe(formatError(failure));
    expect(store.deleting.size).toBe(0);
    expect(useConfirmStore().reserved).toBe(false);
    expect(useConfirmStore().pending).toBeNull();
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockIsSteamRunning).toHaveBeenCalledTimes(1);
  });

  it("deleteOrphans setzt orphanError wenn isSteamRunning im prolog wirft", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();
    const failure = new Error("process-check-unavailable");
    mockIsSteamRunning.mockRejectedValueOnce(failure);
    const logError = vi.spyOn(diagnostics, "logError");

    await expect(
      store.deleteOrphans([
        { appId: 1, type: "shadercache", path: "/fake/shader", library: "/lib" },
      ]),
    ).resolves.toBeUndefined();

    expect(store.orphanError).toBe(formatError(failure));
    expect(logError).toHaveBeenCalledWith(expect.any(String), failure);
    logError.mockRestore();
    expect(store.deleting.size).toBe(0);
    expect(useConfirmStore().reserved).toBe(false);
    expect(useConfirmStore().pending).toBeNull();
    expect(mockReadAllShortcutAppIds).not.toHaveBeenCalled();
    expect(mockPrepareDelete).not.toHaveBeenCalled();
  });

  it.each([
    ["steam läuft", false],
    ["prolog wirft", true],
  ])(
    "deleteOrphans verwirft die prolog-antwort (%s) nach einem neuen orphan-scan",
    async (_label, fails) => {
      const scanStore = useScanStore();
      scanStore.result = fakeScan([]);
      const store = useCleanupStore();
      const steamCheck = deferred<boolean>();
      mockIsSteamRunning.mockImplementationOnce(() => steamCheck.promise);

      const deletion = store.deleteOrphans([
        { appId: 1, type: "shadercache", path: "/fake/shader", library: "/lib" },
      ]);
      await vi.waitFor(() => expect(mockIsSteamRunning).toHaveBeenCalledTimes(1));
      await store.scanOrphans();
      expect(store.orphanError).toBeNull();

      if (fails) steamCheck.reject(new Error("process-check-unavailable"));
      else steamCheck.resolve(true);
      await deletion;

      expect(store.orphanError).toBeNull();
      expect(mockPrepareDelete).not.toHaveBeenCalled();
    },
  );
});
