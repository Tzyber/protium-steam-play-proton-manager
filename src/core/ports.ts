// einzige schnittstelle von core zur außenwelt: adapter implementieren, tests mocken.

/** Größenlimit für Datei-Reads. Eine 2-GB-VDF
 *  würde die webview oomen; steam-dateien sind nie größer (cache-reads werden
 *  mitgecappt, konsistent, schadet nicht). */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** wirft, wenn die datei-größe das limit überschreitet, aufrufer (adapter)
 *  behandeln den Fehler wie einen unlesbaren Pfad. */
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

export interface TrashListing {
  /** kanonischer papierkorb-pfad, den das backend gelesen hat */
  dir: string;
  /** false = kein papierkorb vorhanden (normalfall, kein fehler) */
  present: boolean;
  entries: DirEntry[];
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
  /** Gleiches Dateisystem erlaubt atomare Ersetzung per Temp-Datei und Rename. */
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
  isProcessRunning(name: string): Promise<boolean>;
  dirSize(path: string): Promise<number>;
  /** Größen für viele Pfade auf einmal; ein fehlender Map-Eintrag
   *  bedeutet: pfad wurde übersprungen (z. b. NotFound-race), KEINE größe 0. */
  batchDirSizes(paths: string[]): Promise<Record<string, number>>;
  /** Muss vor Reads auf externen Pfaden laufen, sonst blockiert deren Scope den Zugriff. */
  allowLibraryScope(path: string): Promise<void>;
  /** `(dev, ino)` zur Library-Deduplizierung; `null`, wenn nicht erreichbar. */
  pathIdentity(path: string): Promise<PathIdentity | null>;
  /** Streamt nach `dest`, berechnet SHA512 und meldet Fortschritt per `download-progress`. */
  downloadFile(url: string, dest: string, downloadId: string): Promise<string>;
  /** Lädt das SHA512-Asset über das Backend mit derselben Redirect-Policy wie
   *  download_file (plugin-http folgt redirects ohne scope-recheck). wirft bei
   *  netz-/http-/größenfehler, aufrufer degradiert zu „ohne prüfung" + warning. */
  fetchSha512(url: string): Promise<string>;
  /** Bricht den Download ab und räumt die partielle Datei auf. */
  cancelDownload(downloadId: string): Promise<void>;
  /** Entpackt ein `.tar.gz` nach `dest` mit einer Temp-Datei im Ziel-Dateisystem. */
  extractTarball(src: string, dest: string): Promise<void>;
  /** Entfernt ein GE-Tool aus `compatibilitytools.d` mit Scope-Check auf den
   *  steam-root, tool_name-validierung, symlink-guard, in rust). */
  removeCompatTool(steamRoot: string, toolName: string): Promise<void>;
  /** Schreibt eine Steam-Konfigurationsdatei erst nach Prozesscheck, Backup und
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
