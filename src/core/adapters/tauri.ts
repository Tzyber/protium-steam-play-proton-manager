// ports-implementierung gegen tauri-plugins + rust-commands.
// Einzige Datei mit Tauri-Imports auf der Core-Seite.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import {
  BaseDirectory,
  exists as fsExists,
  remove as fsRemove,
  mkdir,
  readTextFile,
  rename,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type {
  Cache,
  DeleteResult,
  DirEntry,
  EnvironmentSnapshot,
  FileSystem,
  Http,
  HttpResponse,
  InstallGeResult,
  PendingDeleteInfo,
  Ports,
  System,
  TargetArch,
  WriteResult,
} from "../ports.js";

const fs: FileSystem = {
  exists: (path) => invoke<boolean>("environment_exists", { path }),
  readTextFile: (path) => invoke<string>("environment_read_text", { path }),
  readFile: async (path) => {
    const bytes = await invoke<number[] | Uint8Array>("environment_read_binary", { path });
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  },
  async readDir(path) {
    const entries = await invoke<{ name: string; isDirectory: boolean; isSymlink: boolean }[]>(
      "environment_read_dir",
      { path },
    );
    return entries.map(
      (e): DirEntry => ({
        name: e.name,
        isDirectory: e.isDirectory,
        isSymlink: e.isSymlink,
      }),
    );
  },
  // canonicalisierung läuft gegen den aktuellen backend-snapshot.
  realpath: (path) => invoke<string>("canonicalize_path", { path }),
  remove: (path, opts) => fsRemove(path, { recursive: opts?.recursive ?? false }),
  writeTextFile: (path, content) => writeTextFile(path, content),
  rename: (from, to) => rename(from, to),
  mkdir: (path) => mkdir(path, { recursive: true }),
};

const http: Http = {
  async get(url, opts) {
    const res = await tauriFetch(url, { method: "GET", headers: opts?.headers });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, ok: res.ok, text, headers } satisfies HttpResponse;
  },
};

const system: System = {
  geTargetArch: () => invoke<TargetArch>("ge_target_arch"),
  discoverSteamEnvironment: () => invoke<EnvironmentSnapshot>("discover_steam_environment"),
  isProcessRunning: (name) => invoke<boolean>("is_process_running", { name }),
  dirSize: (path) => invoke<number>("dir_size", { path }),
  batchDirSizes: (paths) => invoke<Record<string, number>>("batch_dir_sizes", { paths }),
  listTrashEntries: async (library) => {
    // rust liefert serde-camelCase (isDir), core kennt nur DirEntry (isDirectory)
    const r = await invoke<{
      dir: string;
      present: boolean;
      entries: { name: string; isDir: boolean; isSymlink: boolean }[];
    }>("list_trash_entries", { library });
    return {
      dir: r.dir,
      present: r.present,
      entries: r.entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDir,
        isSymlink: e.isSymlink,
      })),
    };
  },
  pathIdentity: (path) =>
    invoke<{ realpath: string; dev: string; ino: string }>("path_identity", { path }).catch(
      () => null,
    ),
  installGeProton: (params) =>
    invoke<InstallGeResult>("install_ge_proton", {
      steamRoot: params.steamRoot,
      releaseTag: params.releaseTag,
      downloadUrl: params.downloadUrl,
      downloadId: params.downloadId,
    }),
  cancelDownload: (downloadId) => invoke<void>("cancel_download", { downloadId }),
  prepareDelete: (request) =>
    invoke<PendingDeleteInfo>("prepare_delete", {
      request: {
        targetType: request.targetType,
        path: request.path,
        steamRoot: request.steamRoot,
      },
    }),
  executeDelete: (token) => invoke<DeleteResult>("execute_delete", { token }),
  saveLaunchOptions: (steamRoot, accountId, appId, launchOptions) =>
    invoke<WriteResult>("save_launch_options", {
      steamRoot,
      accountId,
      appId,
      launchOptions,
    }),
  saveCompatTool: (steamRoot, appId, toolName) =>
    invoke<WriteResult>("save_compat_tool", {
      steamRoot,
      appId,
      toolName,
    }),
};

// cache als json-dateien unter dem app-cache-dir
const CACHE_SUBDIR = "cache";
let cacheDirReady: Promise<void> | null = null;
function ensureCacheDir(): Promise<void> {
  cacheDirReady ??= mkdir(CACHE_SUBDIR, { baseDir: BaseDirectory.AppCache, recursive: true }).catch(
    () => {},
  );
  return cacheDirReady;
}
function cacheFile(key: string): string {
  return `${CACHE_SUBDIR}/${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

const cache: Cache = {
  async get(key) {
    try {
      await ensureCacheDir();
      const file = cacheFile(key);
      if (!(await fsExists(file, { baseDir: BaseDirectory.AppCache }))) return null;
      return await readTextFile(file, { baseDir: BaseDirectory.AppCache });
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      await ensureCacheDir();
      await writeTextFile(cacheFile(key), value, { baseDir: BaseDirectory.AppCache });
    } catch {
      // Ein Cache-Schreibfehler darf frische Daten nicht verwerfen.
    }
  },
};

export const tauriPorts: Ports = { fs, http, system, cache };

export { appCacheDir };

/** url im system-browser öffnen (eigener command: host-xdg-open, nicht
 * plugin-opener, dessen PATH-lookup nimmt im appimage das gebündelte
 * xdg-open, das auf kde-systemen lautlos scheitert). */
export function openExternal(url: string): Promise<void> {
  return invoke("open_external", { url });
}

/** spiel über steam starten (steam:// handler). steam muss laufen bzw. startet dann. */
export function launchGame(appId: number): Promise<void> {
  return invoke("open_external", { url: `steam://rungameid/${appId}` });
}
