// einzige schnittstelle von core zur außenwelt: adapter implementieren, tests mocken.

/** M4.3 (audit-befund core-A-05): größen-limit für datei-reads. eine 2-GB-vdf
 *  würde die webview oomen; steam-dateien sind nie größer (cache-reads werden
 *  mitgecappt, konsistent, schadet nicht). */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** wirft, wenn die datei-größe das limit überschreitet, aufrufer (adapter)
 *  behandeln den fehler wie einen unlesbaren pfad (INV-2: skip + warning). */
export function ensureSizeLimit(size: number): void {
  if (size > MAX_FILE_BYTES) {
    throw new Error(`datei zu groß (${size} bytes), übersprungen`);
  }
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface TrashDirEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
}

export interface TrashListing {
  /** kanonischer papierkorb-pfad, den das backend gelesen hat */
  dir: string;
  /** false = kein papierkorb vorhanden (normalfall, kein fehler) */
  present: boolean;
  entries: TrashDirEntry[];
}

export interface FileSystem {
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  readDir(path: string): Promise<DirEntry[]>;
  /** symlinks aufgelöst. */
  realpath(path: string): Promise<string>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
  /** gleiches dateisystem → atomar (temp+rename-muster, INV-1). */
  rename(from: string, to: string): Promise<void>;
  /** recursive, fehlende eltern werden mit angelegt. */
  mkdir(path: string): Promise<void>;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  headers: Record<string, string>;
}

export interface Http {
  get(url: string, opts?: { headers?: Record<string, string> }): Promise<HttpResponse>;
}

export interface PathIdentity {
  realpath: string;
  dev: string; // string: große inodes überschreiten JS-number-präzision
  ino: string;
}

export interface System {
  /** R-2 */ isProcessRunning(name: string): Promise<boolean>;
  /** R-3 */ dirSize(path: string): Promise<number>;
  /** R-3b, größen für viele pfade auf einmal; ein fehlender map-eintrag
   *  bedeutet: pfad wurde übersprungen (z. b. NotFound-race), KEINE größe 0. */
  batchDirSizes(paths: string[]): Promise<Record<string, number>>;
  /** R-5, muss vor read auf externen pfaden laufen, sonst blockt der fs-scope (FR-1.3). */
  allowLibraryScope(path: string): Promise<void>;
  /** R-6 (dev,ino) zur library-dedup; null wenn nicht erreichbar. */
  pathIdentity(path: string): Promise<PathIdentity | null>;
  /** R-4 streamt nach dest, sha512 im stream → hex-digest; fortschritt via event "download-progress". */
  downloadFile(url: string, dest: string, downloadId: string): Promise<string>;
  /** S-09: sha512-asset übers backend laden, gleiche redirect-policy wie
   *  download_file (plugin-http folgt redirects ohne scope-recheck). wirft bei
   *  netz-/http-/größenfehler, aufrufer degradiert zu „ohne prüfung" + warning. */
  fetchSha512(url: string): Promise<string>;
  /** R-4 abbrechen; räumt die partielle datei auf. */
  cancelDownload(downloadId: string): Promise<void>;
  /** R-1 .tar.gz nach dest entpacken (temp im ziel-fs, EXDEV-safe). */
  extractTarball(src: string, dest: string): Promise<void>;
  /** M3.4: entfernt ein GE-tool aus compatibilitytools.d (scope-check auf den
   *  steam-root, tool_name-validierung, symlink-guard, in rust). */
  removeCompatTool(steamRoot: string, toolName: string): Promise<void>;
  /** M3.1: steam-config-datei mit vollem INV-1-write-gate in rust (steam-läuft-
   *  check → backup → atomarer temp+rename). `original` = der vor dem patch
   *  gelesene stand (backup-inhalt, TOCTOU-basis); `backup` = vom JS gebauter
   *  backup-pfad im app-cache. */
  writeSteamConfigFile(
    file: string,
    original: string,
    content: string,
    backup: string,
  ): Promise<void>;
  /** listet <library>/steamapps/.protium-trash. in rust, weil der webview-fs-scope
   *  verzeichnisse mit führendem punkt nicht zuverlässig erfasst. */
  listTrashEntries(library: string): Promise<TrashListing>;
}

/** persistenter key/value-cache (protondb TTL, github etag). */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface Ports {
  fs: FileSystem;
  http: Http;
  system: System;
  cache: Cache;
}
