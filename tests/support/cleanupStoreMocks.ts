// T-01: port-basierte mock-preamble für cleanupStore-tests.
// nur `src/core/adapters/tauri` (die echte I/O-grenze) wird durch in-memory
// VFS + port-spies ersetzt; `cleanup`, `cleanupGate`, `shortcuts` und `trash`
// laufen ungemockt. MUSS vor dem store-import geladen werden.

import { vi } from "vitest";
import { paths } from "../../src/core/paths";
import type {
  DirEntry,
  DirectorySize,
  PendingDeleteInfo,
  PrepareDeleteRequest,
  TrashListing,
} from "../../src/core/ports";
import type { TrashEntry } from "../../src/core/trash";
import type { OrphanEntry, OrphanType, ScanResult } from "../../src/core/types";
import {
  game as makeGame,
  orphan as makeOrphan,
  trashEntry as makeTrashEntry,
  scanResult,
} from "./factories";

export const STEAM_ROOT = "/home/u/.steam";
export const TRASH_DIR = paths.trashDir(STEAM_ROOT);

interface VfsFailure {
  error: unknown;
  exists?: boolean;
}

const hoisted = vi.hoisted(() => {
  // DELETE_TOKEN_TTL_SECS = 300 in src-tauri/src/commands/delete_ops.rs.
  // mirrored-constants.test.ts bindet beide Quellen auf denselben Wert.
  const MOCK_TOKEN_TTL_MS = 300_000;

  const dirs = new Map<string, Map<string, DirEntry>>();
  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  const failures = new Map<string, VfsFailure>();
  const existingPaths = new Set<string>();
  const trashListings = new Map<string, TrashListing | { error: unknown }>();
  const cacheStore = new Map<string, string>();

  const notFound = (p: string) => Object.assign(new Error(`not-found: ${p}`), { code: "ENOENT" });

  const existsImpl = async (p: string): Promise<boolean> => {
    const fail = failures.get(p);
    if (fail) return fail.exists ?? true;
    return existingPaths.has(p) || dirs.has(p) || textFiles.has(p) || binaryFiles.has(p);
  };

  const readDirImpl = async (p: string): Promise<DirEntry[]> => {
    const fail = failures.get(p);
    if (fail) throw fail.error;
    const entries = dirs.get(p);
    if (!entries) throw notFound(p);
    return [...entries.values()];
  };

  const readTextFileImpl = async (p: string): Promise<string> => {
    const fail = failures.get(p);
    if (fail) throw fail.error;
    const text = textFiles.get(p);
    if (text === undefined) throw notFound(p);
    return text;
  };

  const readFileImpl = async (p: string): Promise<Uint8Array> => {
    const fail = failures.get(p);
    if (fail) throw fail.error;
    const bin = binaryFiles.get(p);
    if (bin === undefined) throw notFound(p);
    return bin;
  };

  const mockExists = vi.fn(existsImpl);
  const mockReadDir = vi.fn(readDirImpl);
  const mockReadTextFile = vi.fn(readTextFileImpl);
  const mockReadFile = vi.fn(readFileImpl);

  const mockListTrashEntries = vi.fn(async (library: string): Promise<TrashListing> => {
    const entry = trashListings.get(library);
    if (entry && "error" in entry) throw entry.error;
    if (entry) return entry;
    return { dir: `${library}/steamapps/.protium-trash`, present: false, entries: [] };
  });

  const mockPrepareDelete = vi.fn<(req: PrepareDeleteRequest) => Promise<PendingDeleteInfo>>(
    async (req) => ({
      token: `token-${req.path}`,
      expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [],
    }),
  );
  const mockExecuteDelete = vi.fn(async (_token: string) => ({ deletedPath: "" }));
  const mockCancelDelete = vi.fn(async (_token: string) => {});
  const mockBatchDirSizes = vi.fn<(paths: string[]) => Promise<Record<string, DirectorySize>>>(
    async (reqPaths) =>
      Object.fromEntries(reqPaths.map((path) => [path, { status: "missing" as const }])),
  );
  const mockIsSteamRunning = vi.fn(async () => false);

  return {
    MOCK_TOKEN_TTL_MS,
    dirs,
    textFiles,
    binaryFiles,
    failures,
    existingPaths,
    trashListings,
    cacheStore,
    existsImpl,
    readDirImpl,
    readTextFileImpl,
    readFileImpl,
    mockExists,
    mockReadDir,
    mockReadTextFile,
    mockReadFile,
    mockListTrashEntries,
    mockPrepareDelete,
    mockExecuteDelete,
    mockCancelDelete,
    mockBatchDirSizes,
    mockIsSteamRunning,
  };
});

export const {
  MOCK_TOKEN_TTL_MS,
  mockBatchDirSizes,
  mockCancelDelete,
  mockExecuteDelete,
  mockExists,
  mockIsSteamRunning,
  mockListTrashEntries,
  mockPrepareDelete,
  mockReadDir,
  mockReadFile,
  mockReadTextFile,
} = hoisted;

vi.mock("../../src/core/adapters/tauri", () => ({
  tauriPorts: {
    fs: {
      exists: hoisted.mockExists,
      readDir: hoisted.mockReadDir,
      readTextFile: hoisted.mockReadTextFile,
      readFile: hoisted.mockReadFile,
    },
    http: {},
    system: {
      isSteamRunning: hoisted.mockIsSteamRunning,
      listTrashEntries: hoisted.mockListTrashEntries,
      batchDirSizes: hoisted.mockBatchDirSizes,
      prepareDelete: hoisted.mockPrepareDelete,
      executeDelete: hoisted.mockExecuteDelete,
      cancelDelete: hoisted.mockCancelDelete,
    },
    cache: {
      get: async (k: string) => hoisted.cacheStore.get(k) ?? null,
      set: async (k: string, v: string) => {
        hoisted.cacheStore.set(k, v);
      },
    },
  },
}));

/** Stellt einen sauberen VFS- und Spy-Zustand her. `clearCache = false`
 *  behält den in-memory Cache für Pinia-Neustart-Tests bei. */
export function resetCleanupMocks(opts: { clearCache?: boolean } = {}): void {
  hoisted.dirs.clear();
  hoisted.textFiles.clear();
  hoisted.binaryFiles.clear();
  hoisted.failures.clear();
  hoisted.existingPaths.clear();
  hoisted.trashListings.clear();
  if (opts.clearCache !== false) hoisted.cacheStore.clear();

  hoisted.mockExists.mockReset().mockImplementation(hoisted.existsImpl);
  hoisted.mockReadDir.mockReset().mockImplementation(hoisted.readDirImpl);
  hoisted.mockReadTextFile.mockReset().mockImplementation(hoisted.readTextFileImpl);
  hoisted.mockReadFile.mockReset().mockImplementation(hoisted.readFileImpl);

  hoisted.mockListTrashEntries.mockReset();
  hoisted.mockListTrashEntries.mockImplementation(async (library: string) => {
    const entry = hoisted.trashListings.get(library);
    if (entry && "error" in entry) throw entry.error;
    if (entry) return entry;
    return { dir: `${library}/steamapps/.protium-trash`, present: false, entries: [] };
  });

  hoisted.mockPrepareDelete.mockReset();
  hoisted.mockPrepareDelete.mockImplementation(async (req) => ({
    token: `token-${req.path}`,
    expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
    targetType: req.targetType,
    targetPath: req.path,
    consequences: [],
  }));
  hoisted.mockExecuteDelete.mockReset();
  hoisted.mockExecuteDelete.mockResolvedValue({ deletedPath: "" });
  hoisted.mockCancelDelete.mockReset();
  hoisted.mockCancelDelete.mockResolvedValue(undefined);
  hoisted.mockBatchDirSizes.mockReset();
  hoisted.mockBatchDirSizes.mockImplementation(async (reqPaths) =>
    Object.fromEntries(reqPaths.map((path) => [path, { status: "missing" as const }])),
  );
  hoisted.mockIsSteamRunning.mockReset();
  hoisted.mockIsSteamRunning.mockResolvedValue(false);
}

export function addDirEntry(dir: string, entry: DirEntry): void {
  hoisted.existingPaths.add(dir);
  let map = hoisted.dirs.get(dir);
  if (!map) {
    map = new Map<string, DirEntry>();
    hoisted.dirs.set(dir, map);
  }
  map.set(entry.name, entry);
  if (entry.isDirectory && !entry.isSymlink) {
    const child = `${dir}/${entry.name}`;
    hoisted.existingPaths.add(child);
    if (!hoisted.dirs.has(child)) hoisted.dirs.set(child, new Map());
  }
}

export function setOrphanDirs(
  items: { appId: number | string; type: OrphanType; library?: string }[],
): void {
  for (const item of items) {
    const library = item.library ?? STEAM_ROOT;
    const baseDir =
      item.type === "compatdata" ? paths.compatdataDir(library) : paths.shadercacheDir(library);
    addDirEntry(baseDir, { name: String(item.appId), isDirectory: true, isSymlink: false });
  }
}

export function setClaimDir(dir: string, name: string): void {
  addDirEntry(dir, { name, isDirectory: true, isSymlink: false });
}

export function clearDirEntries(dir: string): void {
  hoisted.dirs.delete(dir);
  hoisted.existingPaths.delete(dir);
}

export function failVfsPath(path: string, error: unknown, exists = true): void {
  hoisted.failures.set(path, { error, exists });
  if (exists) hoisted.existingPaths.add(path);
}

export function setTextFile(path: string, content: string): void {
  hoisted.textFiles.set(path, content);
  hoisted.existingPaths.add(path);
}

export function setBinaryFile(path: string, bytes: Uint8Array): void {
  hoisted.binaryFiles.set(path, bytes);
  hoisted.existingPaths.add(path);
}

/** Minimale binäre `shortcuts.vdf`-Datei für echte Parser-Integration. */
export function encodeShortcutsVdf(appIds: number[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: number[] = [0x00, ...enc.encode("shortcuts"), 0x00];
  appIds.forEach((id, index) => {
    chunks.push(0x00, ...enc.encode(String(index)), 0x00);
    chunks.push(0x02, ...enc.encode("appid"), 0x00);
    chunks.push(id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, (id >> 24) & 0xff);
    chunks.push(0x08);
  });
  chunks.push(0x08);
  return new Uint8Array(chunks);
}

export function seedShortcutIds(
  appIds: number[],
  opts: { steamRoot?: string; userId?: string } = {},
): void {
  const steamRoot = opts.steamRoot ?? STEAM_ROOT;
  const userId = opts.userId ?? "123";
  addDirEntry(paths.userdataDir(steamRoot), {
    name: userId,
    isDirectory: true,
    isSymlink: false,
  });
  addDirEntry(paths.userdataAccountDir(steamRoot, userId), {
    name: "config",
    isDirectory: true,
    isSymlink: false,
  });
  setBinaryFile(paths.shortcutsVdf(steamRoot, userId), encodeShortcutsVdf(appIds));
}

export function seedTrashEntries(
  entries: TrashEntry[],
  opts: { library?: string; unknownNames?: string[]; error?: unknown } = {},
): void {
  const library = opts.library ?? STEAM_ROOT;
  if (opts.error !== undefined) {
    hoisted.trashListings.set(library, { error: opts.error });
    return;
  }
  const dir = paths.trashDir(library);
  const list: DirEntry[] = [
    ...entries.map((entry) => ({ name: entry.name, isDirectory: true, isSymlink: false })),
    ...(opts.unknownNames ?? []).map((name) => ({
      name,
      isDirectory: true,
      isSymlink: false,
    })),
  ];
  hoisted.trashListings.set(library, { dir, present: true, entries: list });
}

export function trashListing(entries: TrashEntry[], library = STEAM_ROOT): TrashListing {
  return {
    dir: paths.trashDir(library),
    present: true,
    entries: entries.map((entry) => ({ name: entry.name, isDirectory: true, isSymlink: false })),
  };
}

export function fakeScan(
  skipped?: ScanResult["skippedLibraries"],
  cleanupUnsafeLibraries?: string[],
): ScanResult {
  return scanResult({
    steamRoot: STEAM_ROOT,
    libraries: [STEAM_ROOT],
    skippedLibraries: skipped ?? [],
    cleanupUnsafeLibraries: cleanupUnsafeLibraries ?? [],
  });
}

export function fakeScanWithGames(gameIds: number[]): ScanResult {
  return { ...fakeScan(), games: gameIds.map((appId) => makeGame({ appId, library: STEAM_ROOT })) };
}

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
      path: `${TRASH_DIR}/compatdata_${1000000 + index}_100`,
      name: `compatdata_${1000000 + index}_100`,
      appId: 1000000 + index,
      trashedAt: 100,
    }),
  );
}
