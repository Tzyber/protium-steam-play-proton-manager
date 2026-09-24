// UI-freie Domänentypen ohne Vue- oder Tauri-Imports.

/** Die Wertelisten sind die Wahrheit: die Union-Typen und die
 *  Laufzeit-Validatoren leiten daraus ab. Eine neue stufe oder ein neuer
 *  status wird hier ergänzt und ist damit überall bekannt; vorher stand
 *  dieselbe menge in vier dateien. */
const TIERS = ["platinum", "gold", "silver", "bronze", "borked", "unknown"] as const;
export type Tier = (typeof TIERS)[number];

const COMPAT_CONFIG_STATUSES = ["available", "missing", "unreadable"] as const;
const LAUNCH_CONFIG_STATUSES = [...COMPAT_CONFIG_STATUSES, "ambiguous"] as const;
const COMPAT_TOOL_SOURCES = ["explicit", "default", "unavailable"] as const;
export const ORPHAN_TYPES = ["compatdata", "shadercache"] as const;

export type CompatConfigStatus = (typeof COMPAT_CONFIG_STATUSES)[number];

/** launch-config zusätzlich "ambiguous": Datei lesbar, aber die Auswahl des
 *  aktiven Accounts (loginusers.vdf) war nicht eindeutig. Kein Read-Fehler,
 *  aber die Quelle ist nicht sicher bestimmt → Coverage limited. */
export type LaunchConfigStatus = (typeof LAUNCH_CONFIG_STATUSES)[number];

/** prüft einen rohwert gegen eine werteliste; `undefined` = unbekannt. */
function oneOf<T extends string>(values: readonly T[], raw: unknown): T | undefined {
  return typeof raw === "string" && (values as readonly string[]).includes(raw)
    ? (raw as T)
    : undefined;
}

/** protondb-stufe eines rohwerts; unbekanntes wird zu "unknown". */
export function asTier(raw: unknown): Tier {
  return oneOf(TIERS, raw) ?? "unknown";
}

/** compat-config-status aus einem rohwert (support-projektion, INV-3). */
export function asCompatConfigStatus(raw: unknown): CompatConfigStatus | "unknown" {
  return oneOf(COMPAT_CONFIG_STATUSES, raw) ?? "unknown";
}

/** launch-config-status aus einem rohwert; "ambiguous" ist ein eigener fall. */
export function asLaunchConfigStatus(raw: unknown): LaunchConfigStatus | "unknown" {
  return oneOf(LAUNCH_CONFIG_STATUSES, raw) ?? "unknown";
}

/** quelle einer compat-zuordnung; unbekanntes gilt als "unavailable". */
export function asCompatToolSource(raw: unknown): CompatToolSource {
  return oneOf(COMPAT_TOOL_SOURCES, raw) ?? "unavailable";
}

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

/** String-Sentinels, die in `compatTool` stehen können, aber keinen echten
 *  tool-namen bezeichnen: "default" = globaler Standard, "unknown" = keine
 *  aussage (config unlesbar). Zentrale liste gegen drift (K-06). */
export const COMPAT_TOOL_SENTINELS = ["default", "unknown"] as const;
export type CompatToolSentinel = (typeof COMPAT_TOOL_SENTINELS)[number];

export function isCompatToolSentinel(value: string): value is CompatToolSentinel {
  return (COMPAT_TOOL_SENTINELS as readonly string[]).includes(value);
}

/** installierter built-in proton (experimental, hotfix, proton_9/10/…): der
 *  interne name steht im mapping, der display-name kommt aus der tool-vdf. */
export interface BuiltinProton {
  internalName: string;
  displayName: string;
}

/** zähler eines scan-abschnitts: gelesen gegen fehlgeschlagen. */
export interface ReadFailedCounts {
  read: number;
  failed: number;
}

export interface ScanCoverage {
  state: "complete" | "incomplete" | "limited";
  libraries: { total: number; read: number; unavailable: number };
  compatConfig: CompatConfigStatus;
  launchConfig: LaunchConfigStatus;
  manifests: ReadFailedCounts;
  tools: ReadFailedCounts;
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
  /** zuletzt gespielt als unix-sekunden aus `LastPlayed` in localconfig.vdf;
   *  undefined = unbekannt oder nie gespielt (steam schreibt `"0"`). */
  lastPlayed?: number;
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
  builtinProtonsInstalled: BuiltinProton[];
  /** globaler default aus CompatToolMapping[0] ("für alle spiele"), sonst null. */
  defaultCompatTool: string | null;
  compatConfigStatus: CompatConfigStatus;
  /** account, dessen localconfig.vdf gelesen wird (null = keiner gefunden → keine startoptionen). */
  steamUserId: string | null;
  launchConfigStatus: LaunchConfigStatus;
  manifestCounts: ReadFailedCounts;
  compatToolCounts: ReadFailedCounts;
  warnings: ScanWarning[];
  skippedLibraries: SkippedLibrary[];
  cleanupUnsafeLibraries: string[];
  /** appIDs mit existierendem manifest, die kein spiel sind (blocklist,
   *  z. b. proton-builtin-pakete). cleanup darf ihre prefixes nie als
   *  orphans anbieten. */
  blockedAppIds: number[];
}

/** `unverified` = das backend hat keinen grund geliefert (z. b. snapshot ohne
 *  das feld); der zustand ist unbekannt und blockiert das cleanup wie ein
 *  zugriffsfehler. */
export type SkipReason = "path-missing" | "scope-failed" | "read-failed" | "unverified";

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
