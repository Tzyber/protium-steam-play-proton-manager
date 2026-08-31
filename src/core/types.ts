// UI-freie Domänentypen ohne Vue- oder Tauri-Imports.

export type Tier = "platinum" | "gold" | "silver" | "bronze" | "borked" | "unknown";

export type CompatConfigStatus = "available" | "missing" | "unreadable";

/** launch-config zusätzlich "ambiguous": Datei lesbar, aber die Auswahl des
 *  aktiven Accounts (loginusers.vdf) war nicht eindeutig. Kein Read-Fehler,
 *  aber die Quelle ist nicht sicher bestimmt → Coverage limited. */
export type LaunchConfigStatus = CompatConfigStatus | "ambiguous";

export type ScanWarning =
  | {
      type: "library";
      path: string;
      reason: SkipReason;
      detail?: string;
    }
  | {
      type: "compat-config";
      reason: "missing" | "unreadable";
      detail?: string;
    }
  | {
      type: "launch-config";
      reason: "missing" | "unreadable" | "selection-ambiguous";
      steamUserId?: string;
      detail?: string;
    }
  | {
      type: "manifest";
      library: string;
      manifestName: string;
      appId?: number;
      reason:
        | "invalid-filename"
        | "unreadable"
        | "invalid-content"
        | "appid-mismatch"
        | "duplicate"
        | "name-heuristic";
      detail?: string;
    }
  | {
      type: "compat-tool";
      directory: string;
      toolName?: string;
      reason:
        | "path-identity"
        | "directory-unreadable"
        | "symlink"
        | "vdf-unreadable"
        | "vdf-invalid"
        | "size-unreadable";
      detail?: string;
    };

export type CompatToolSource = "explicit" | "default" | "unavailable";

export interface ScanCoverage {
  state: "complete" | "incomplete" | "limited";
  libraries: { total: number; read: number; unavailable: number };
  compatConfig: CompatConfigStatus;
  launchConfig: LaunchConfigStatus;
  manifests: { read: number; failed: number };
  tools: { read: number; failed: number };
}

export interface Game {
  appId: number;
  name: string;
  library: string;
  /** Größe aus `SizeOnDisk` im Steam-Appmanifest; undefined bedeutet unbekannt. */
  sizeBytes?: number;
  /** Installationsordner aus dem Appmanifest; undefined bedeutet unsicher oder unbekannt. */
  installdir?: string;
  compatTool: string; // "GE-Proton9-27" | "proton_experimental" | "default" | "unknown"
  compatToolSource: CompatToolSource;
  protonDb: { tier: Tier; confidence: string } | null;
  localHeader: string | null; // bevorzugt (CDN-unabhängig)
  headerImage: string | null; // CDN-fallback
  launchOptions?: string;
}

export interface CompatTool {
  name: string; // verzeichnisname in compatibilitytools.d (für fs-ops: größe, löschen)
  internalName: string; // key aus compatibilitytool.vdf → steht so in config.vdf-mapping
  displayName: string;
  /** undefined = Größenmessung fehlt oder fehlgeschlagen; Tool ist trotzdem erkannt. Nie still 0. */
  sizeBytes?: number;
  usedBy: number[]; // appIds, die dieses tool via mapping nutzen
  source: "user" | "system"; // system = distro-dir (/usr/share/…), read-only
}

export interface ScanResult {
  steamRoot: string;
  libraries: string[];
  games: Game[];
  compatToolsInstalled: CompatTool[];
  /** installierte built-in protons (experimental, hotfix, proton_9/10/…). */
  builtinProtonsInstalled: { internalName: string; displayName: string }[];
  /** globaler default aus CompatToolMapping[0] ("für alle spiele"), sonst null. */
  defaultCompatTool: string | null;
  compatConfigStatus: CompatConfigStatus;
  /** account, dessen localconfig.vdf gelesen wird (null = keiner gefunden → keine startoptionen). */
  steamUserId: string | null;
  launchConfigStatus: LaunchConfigStatus;
  manifestCounts: { read: number; failed: number };
  compatToolCounts: { read: number; failed: number };
  warnings: ScanWarning[];
  skippedLibraries: SkippedLibrary[];
  cleanupUnsafeLibraries: string[];
  /** appIDs mit existierendem manifest, die kein spiel sind (blocklist,
   *  z. b. proton-builtin-pakete). cleanup darf ihre prefixes nie als
   *  orphans anbieten. */
  blockedAppIds: number[];
}

export type SkipReason = "path-missing" | "scope-failed" | "read-failed";

export interface SkippedLibrary {
  path: string;
  reason: SkipReason;
}

export type OrphanType = "compatdata" | "shadercache";

export interface OrphanEntry {
  appId: number;
  type: OrphanType;
  path: string;
  library: string;
  sizeBytes?: number;
  potentialShortcut?: boolean;
}

/** Prüft vor `parseSafeAppId`, ob eine App-ID nur Ziffern enthält. */
export const NUMERIC_RE = /^\d+$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Obergrenze gültiger Steam-App-IDs: u32::MAX. Spiegel zur Rust-Grenze in
 *  `parse_app_id` (scope.rs). Non-Steam-Shortcut-IDs belegen legitim den
 *  Bereich 2^31..2^32−1 (Bit 31 gesetzt) und müssen angeboten werden können. */
export const MAX_APP_ID = 4_294_967_295;

/** Riesige Ziffernfolgen parsen jenseits der JS-Präzision (NAME_MAX erlaubt
 *  254 Ziffern → 1.8e254). solche strings sind nie gültige u32-IDs; der
 *  `Number.isSafeInteger`-Guard weist sie ab, bevor die Grenzprüfung greift.
 *  null = kein brauchbarer wert. */
export function parseSafeAppId(str: string): number | null {
  if (!NUMERIC_RE.test(str)) return null;
  const appId = Number.parseInt(str, 10);
  if (appId < 1 || appId > MAX_APP_ID || !Number.isSafeInteger(appId)) return null;
  return appId;
}

export class SteamNotFoundError extends Error {
  constructor(triedPaths: string[]) {
    super(`keine steam-installation gefunden. geprüfte pfade: ${triedPaths.join(", ")}`);
    this.name = "SteamNotFoundError";
  }
}
