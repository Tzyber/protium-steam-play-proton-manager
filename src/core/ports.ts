// einzige schnittstelle von core zur außenwelt: adapter implementieren, tests mocken.

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

export type TargetArch = "x86_64" | "aarch64";

export interface EnvironmentSnapshot {
  generation: number;
  steamRoot: string;
  libraries: string[];
  systemCompatDirs: string[];
  appCacheDir: string;
  appConfigDir: string;
}

export type DirectorySize =
  | { status: "measured"; sizeBytes: number }
  | { status: "missing" }
  | { status: "failed"; detail?: string };

export interface System {
  /** Liefert ausschließlich die vom Rust-Backend kompilierte GE-Zielarchitektur. */
  geTargetArch(): Promise<TargetArch>;
  isProcessRunning(name: string): Promise<boolean>;
  dirSize(path: string): Promise<DirectorySize>;
  /** Liefert für jeden angeforderten Pfad einen expliziten Status. */
  batchDirSizes(paths: string[]): Promise<Record<string, DirectorySize>>;
  /** entdeckt und ersetzt den atomaren, backendautorisierten Environment-Snapshot. */
  discoverSteamEnvironment(): Promise<EnvironmentSnapshot>;
  /** `(dev, ino)` zur Library-Deduplizierung; `null`, wenn nicht erreichbar. */
  pathIdentity(path: string): Promise<PathIdentity | null>;
  /** Installiert ein GE-Proton-Release atomar, mit Hash-Verifikation und Swap-Schutz. */
  installGeProton(params: GeInstallParams): Promise<InstallGeResult>;
  /** Bricht den Download ab und räumt die partielle Datei auf. */
  cancelDownload(downloadId: string): Promise<void>;
  /** Bereitet eine Löschung vor (frischer Live-Zustandsabgleich, Token-Generierung). */
  prepareDelete(request: PrepareDeleteRequest): Promise<PendingDeleteInfo>;
  /** Führt die vorbereitete Löschung nach Bestätigung im Hauptfenster aus. */
  executeDelete(token: string): Promise<DeleteResult>;
  /** Speichert Startoptionen in `localconfig.vdf` via backendkontrolliertem Write-Gate. */
  saveLaunchOptions(
    steamRoot: string,
    accountId: string,
    appId: number,
    launchOptions: string,
  ): Promise<WriteResult>;
  /** Speichert Compat-Tool-Mapping in `config.vdf` via backendkontrolliertem Write-Gate. */
  saveCompatTool(steamRoot: string, appId: number, toolName: string | null): Promise<WriteResult>;
  /** listet <library>/steamapps/.protium-trash über den aktuellen Backend-Snapshot. */
  listTrashEntries(library: string): Promise<TrashListing>;
}

export type DeleteTargetType = "orphan" | "trash" | "compatTool";

export interface PrepareDeleteRequest {
  targetType: DeleteTargetType;
  path: string;
  steamRoot: string;
}

export interface DeleteConsequence {
  path: string;
  action: "trash" | "permanentDelete";
  description: string;
  affectedAppIds?: number[];
}

export interface PendingDeleteInfo {
  token: string;
  expiresAt: number;
  targetType: DeleteTargetType;
  targetPath: string;
  consequences: DeleteConsequence[];
}

export interface DeleteResult {
  success: boolean;
  deletedPath: string;
}

export interface GeInstallParams {
  steamRoot: string;
  releaseTag: string;
  downloadUrl: string;
  downloadId: string;
}

export type InstallGeResult = "verified" | "unverified";

export type WriteResult = "written" | "unchanged";

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
