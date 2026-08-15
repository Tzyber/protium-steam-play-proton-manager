// UI-freie Domänentypen ohne Vue- oder Tauri-Imports.

export type Tier = "platinum" | "gold" | "silver" | "bronze" | "borked" | "unknown";

export interface Game {
  appId: number;
  name: string;
  library: string;
  sizeBytes: number;
  compatTool: string; // "GE-Proton9-27" | "proton_experimental" | "default" | "unknown"
  protonDb: { tier: Tier; confidence: string } | null;
  localHeader: string | null; // bevorzugt (CDN-unabhängig)
  headerImage: string | null; // CDN-fallback
  launchOptions?: string;
}

export interface CompatTool {
  name: string; // verzeichnisname in compatibilitytools.d (für fs-ops: größe, löschen)
  internalName: string; // key aus compatibilitytool.vdf → steht so in config.vdf-mapping
  displayName: string;
  sizeBytes: number;
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
  /** account, dessen localconfig.vdf gelesen wird (null = keiner gefunden → keine startoptionen). */
  steamUserId: string | null;
  warnings: string[];
  skippedLibraries: SkippedLibrary[];
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

/** Riesige Ziffernfolgen parsen jenseits der
 *  JS-präzision (NAME_MAX erlaubt 254 ziffern → 1.8e254). solche appIds
 *  sind nie legitim (steam: ≤ 10 stellen) und würden das rust-backend
 *  (u64-parse) beim löschen ratlos lassen. null = kein brauchbarer wert. */
export function parseSafeAppId(str: string): number | null {
  const appId = Number.parseInt(str, 10);
  if (appId === 0 || !Number.isFinite(appId) || appId > Number.MAX_SAFE_INTEGER) return null;
  return appId;
}

export class SteamNotFoundError extends Error {
  constructor(triedPaths: string[]) {
    super(`keine steam-installation gefunden. geprüfte pfade: ${triedPaths.join(", ")}`);
    this.name = "SteamNotFoundError";
  }
}
