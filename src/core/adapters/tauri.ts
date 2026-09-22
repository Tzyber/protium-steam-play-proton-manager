// ports-implementierung gegen tauri-plugins + rust-commands.
// Einzige Datei mit Tauri-Imports auf der Core-Seite.
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BaseDirectory,
  exists as fsExists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type {
  Cache,
  DeleteResult,
  DirEntry,
  DirectorySize,
  DownloadProgressEvent,
  EnvironmentSnapshot,
  FileSystem,
  Http,
  HttpResponse,
  InstallGeResult,
  InstallPhaseEvent,
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
    // rust liefert eine binäre ipc-response (raw bytes statt json-array)
    const bytes = await invoke<ArrayBuffer>("environment_read_binary", { path });
    return new Uint8Array(bytes);
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
};

// plugin-http kennt nur connectTimeout, keinen read-timeout: ein server, der
// die verbindung annimmt und nichts sendet, würde den aufrufer sonst endlos
// hängen lassen (INV-3). der timer umfasst fetch UND body-read.
const HTTP_TIMEOUT_MS = 30_000;

const http: Http = {
  async get(url, opts) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("HTTP request timed out")), HTTP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        (async () => {
          const res = await tauriFetch(url, {
            method: "GET",
            headers: opts?.headers,
            connectTimeout: 10_000,
          });
          const text = await res.text();
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = v;
          });
          return { status: res.status, ok: res.ok, text, headers } satisfies HttpResponse;
        })(),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};

const system: System = {
  geTargetArch: () => invoke<TargetArch>("ge_target_arch"),
  discoverSteamEnvironment: () => invoke<EnvironmentSnapshot>("discover_steam_environment"),
  isProcessRunning: (name) => invoke<boolean>("is_process_running", { name }),
  dirSize: (path) => invoke<DirectorySize>("dir_size", { path }),
  batchDirSizes: (paths) => invoke<Record<string, DirectorySize>>("batch_dir_sizes", { paths }),
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
  // Die Event-API von Tauri bleibt hier: die UI-Schicht kennt nur diese zwei
  // Abos, damit ein Ladeprogress-Listener kein Tauri-Import in einem Store ist.
  onDownloadProgress: (handler) =>
    listen<DownloadProgressEvent>("download-progress", (event) => handler(event.payload)),
  onInstallPhase: (handler) =>
    listen<InstallPhaseEvent>("install-phase", (event) => handler(event.payload)),
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

export function openPrefixFolder(library: string, appId: number): Promise<void> {
  return invoke("open_prefix_folder", { library, appId: String(appId) });
}

export interface ConfigBackupEntry {
  fileName: string;
  kind: "localconfig" | "config";
  targetId: string;
  timestampMs: number;
  sizeBytes: number;
}

export function listConfigBackups(): Promise<ConfigBackupEntry[]> {
  return invoke<ConfigBackupEntry[]>("list_config_backups");
}

export function openBackupsFolder(): Promise<void> {
  return invoke("open_backups_folder");
}

export function logDiagnostic(level: "info" | "warn" | "error", message: string): Promise<void> {
  return invoke("log_diagnostic", { level, message });
}

export function appVersion(): Promise<string> {
  return getVersion();
}

export function readLogTail(): Promise<string> {
  return invoke<string>("read_log_tail");
}

export function openLogsFolder(): Promise<void> {
  return invoke("open_logs_folder");
}
