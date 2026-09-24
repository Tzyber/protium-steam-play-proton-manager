// warum (T-01): die drei cleanupStore-Testdateien trugen dieselbe Mock-Preamble
// dreifach — je ein vi.hoisted-Block und vier identische vi.mock-Blöcke. Jede
// Änderung an der Port-Form musste dreimal nachgezogen werden. Hier steht sie
// einmal. Die Datei registriert die Mocks beim Import als Seiteneffekt, deshalb
// MUSS sie in den Testdateien VOR den Stores/Modulen unter Test importiert
// werden — sonst lädt der Modulgraph die echten Ports.
//
// Die Mocks liefern exakt dieselben Module/Funktionen wie die alten lokalen
// Preambles (findOrphans, findIncompleteDeletions, findSteamOwnedPrefixes,
// classifyOrphans, readAllShortcutAppIds, SHORTCUT_ID_THRESHOLD,
// findTrashEntries, tauriPorts).

import { vi } from "vitest";
import type {
  findIncompleteDeletions,
  findOrphans,
  findSteamOwnedPrefixes,
} from "../../src/core/cleanup";
import type { DirectorySize, PendingDeleteInfo, PrepareDeleteRequest } from "../../src/core/ports";
import type { readAllShortcutAppIds } from "../../src/core/shortcuts";
import type { findTrashEntries, TrashEntry } from "../../src/core/trash";
import type { OrphanEntry, ScanResult } from "../../src/core/types";
import { orphan as makeOrphan, trashEntry as makeTrashEntry, scanResult } from "./factories";

const hoisted = vi.hoisted(() => {
  // DELETE_TOKEN_TTL_SECS = 300 in src-tauri/src/commands/delete_ops.rs (siehe
  // SECURITY.md). Der Mock-Token spiegelt die echte Produktions-Lebensdauer,
  // statt eine erfundene 60-s-Grenze zu prüfen, die das Backend nie ausgibt.
  const MOCK_TOKEN_TTL_MS = 300_000;
  return {
    MOCK_TOKEN_TTL_MS,
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
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
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
  };
});

const {
  MOCK_TOKEN_TTL_MS,
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
} = hoisted;

export {
  MOCK_TOKEN_TTL_MS,
  mockBatchDirSizes,
  mockExecuteDelete,
  mockFindIncompleteDeletions,
  mockFindOrphans,
  mockFindSteamOwnedPrefixes,
  mockFindTrashEntries,
  mockIsProcessRunning,
  mockPrepareDelete,
  mockReadAllShortcutAppIds,
  mockReadLocalConfig,
};

vi.mock("../../src/core/cleanup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/cleanup")>();
  return {
    findOrphans: mockFindOrphans,
    findIncompleteDeletions: mockFindIncompleteDeletions,
    findSteamOwnedPrefixes: mockFindSteamOwnedPrefixes,
    // klassifikation (U-04) ist rein und wird ungemockt mitgetestet
    classifyOrphans: actual.classifyOrphans,
  };
});
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

/** Setzt alle cleanup-Ports auf denselben neutralen Stand zurück, den die
 *  früheren, fast gleichen beforeEach-Resets je Datei herstellten (T-07). Die
 *  Pinia-/Locale-Vorbereitung bleibt Sache der Testdatei, weil dort die
 *  erwartete Sprache und der Store-Lifecycle sichtbar sind. */
export function resetCleanupMocks(): void {
  mockFindOrphans.mockReset();
  mockFindOrphans.mockResolvedValue([]);
  mockFindIncompleteDeletions.mockReset();
  mockFindIncompleteDeletions.mockResolvedValue({ entries: [], unreadable: [] });
  mockFindSteamOwnedPrefixes.mockReset();
  mockFindSteamOwnedPrefixes.mockResolvedValue([]);
  mockReadAllShortcutAppIds.mockReset();
  mockReadAllShortcutAppIds.mockResolvedValue({ status: "none" });
  mockFindTrashEntries.mockReset();
  mockFindTrashEntries.mockResolvedValue({
    entries: [],
    unknown: [],
    unreadable: [],
    libraries: [],
  });
  mockPrepareDelete.mockReset();
  mockPrepareDelete.mockImplementation(async (req) => ({
    token: `token-${req.path}`,
    expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
    targetType: req.targetType,
    targetPath: req.path,
    consequences: [],
  }));
  mockExecuteDelete.mockReset();
  mockExecuteDelete.mockResolvedValue({ deletedPath: "" });
  mockBatchDirSizes.mockReset();
  mockBatchDirSizes.mockImplementation(async (paths) =>
    Object.fromEntries(paths.map((path) => [path, { status: "missing" as const }])),
  );
  mockReadLocalConfig.mockReset();
  mockReadLocalConfig.mockResolvedValue("");
  mockIsProcessRunning.mockReset();
  mockIsProcessRunning.mockResolvedValue(false);
}

/** Scan-Snapshot mit leerem Inventar; nur skipped/unsafe-Libraries variieren in
 *  den Tests. Ersetzt die dreifach kopierte lokale Variante (T-07). */
export function fakeScan(
  skipped?: ScanResult["skippedLibraries"],
  cleanupUnsafeLibraries?: string[],
): ScanResult {
  return scanResult({
    skippedLibraries: skipped ?? [],
    cleanupUnsafeLibraries: cleanupUnsafeLibraries ?? [],
  });
}

/** Papierkorb-Eintrag mit den Werten, auf die die cleanupStore-Tests bauen;
 *  die Objektform kommt aus `factories.trashEntry` (T-07), nur die Test-Defaults
 *  bleiben hier. */
export function fakeTrashEntry(overrides: Partial<TrashEntry> = {}): TrashEntry {
  return makeTrashEntry({ appId: 1091500, trashedAt: 1753372800123, ...overrides });
}

export function fakeOrphanEntry(index: number): OrphanEntry {
  return makeOrphan(900000 + index, "shadercache");
}

export function fakeOrphanEntries(count: number): OrphanEntry[] {
  return Array.from({ length: count }, (_, index) => fakeOrphanEntry(index + 1));
}

export function fakeTrashEntries(count: number): TrashEntry[] {
  return Array.from({ length: count }, (_, index) =>
    fakeTrashEntry({
      path: `/lib/steamapps/.protium-trash/compatdata_${1000000 + index}_100`,
      name: `compatdata_${1000000 + index}_100`,
      appId: 1000000 + index,
    }),
  );
}
