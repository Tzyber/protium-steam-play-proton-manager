import { blockReason } from "../blocklist.js";
import { errText } from "../errtext.js";
import { readAppFields } from "../localconfig.js";
import { parseManifest } from "../manifest.js";
import { joinPath, paths } from "../paths.js";
import type { DirEntry, Ports } from "../ports.js";
import {
  type Game,
  parseSafeAppId,
  type ReadFailedCounts,
  type ScanWarning,
  type SkippedLibrary,
} from "../types.js";
import { resolveLocalHeader } from "./cover.js";

const MANIFEST_RE = /^appmanifest_(\d+)\.acf$/;

interface ScanGamesResult {
  games: Game[];
  blockedAppIds: Set<number>;
  warnings: ScanWarning[];
  skippedLibraries: SkippedLibrary[];
  cleanupUnsafeLibraries: string[];
  manifestCounts: ReadFailedCounts;
  /** grund, wenn die localconfig eines spiels nicht parsebar war; der aufrufer
   *  degradiert damit `launchConfigStatus` scan-weit (INV-2: skip + warnung). */
  localConfigDegraded: string | null;
}

/** Zuordnung eines spiels zu einem compat-tool als diskriminierte union statt
 *  freiem `CompatAssignment | string` (K-06): `compatToolSource` ist das
 *  diskriminanzfeld, `compatTool` trägt den namen. Ein mappingwert
 *  "default"/"unknown" bleibt als echter expliziter wert erlaubt (kommt real in
 *  config.vdf vor), aber ein unbekannter string fällt nicht mehr still in
 *  `explicit`. */
export type CompatAssignment =
  | { compatToolSource: "explicit"; compatTool: string }
  | { compatToolSource: "default"; compatTool: "default" }
  | { compatToolSource: "unavailable"; compatTool: "default" | "unknown" };

type CompatFor = (appId: number) => CompatAssignment;

type ManifestData = ReturnType<typeof parseManifest>;
type LocalConfigApps = ReturnType<typeof readAppFields>;

/** localconfig-rohwert → unix-sekunden; `"0"` und unsinn bleiben unbekannt. */
function parseLastPlayed(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** listet die einträge einer library. fehlendes oder unlesbares steamapps wird
 *  gemeldet und übersprungen: leere liste statt `continue` im aufrufer. */
async function readLibraryEntries(
  fs: Ports["fs"],
  lib: string,
  warnings: ScanWarning[],
  skippedLibraries: SkippedLibrary[],
): Promise<{ appsDir: string; entries: DirEntry[] }> {
  const appsDir = paths.libraryAppsDir(lib);
  try {
    if (!(await fs.exists(appsDir))) {
      warnings.push({
        type: "library",
        path: lib,
        reason: "path-missing",
        detail: `library "${lib}" missing: steamapps`,
      });
      skippedLibraries.push({ path: lib, reason: "path-missing" });
      return { appsDir, entries: [] };
    }
    return { appsDir, entries: await fs.readDir(appsDir) };
  } catch (e) {
    warnings.push({
      type: "library",
      path: lib,
      reason: "read-failed",
      detail: `library "${lib}" not readable: ${errText(e)}`,
    });
    skippedLibraries.push({ path: lib, reason: "read-failed" });
    return { appsDir, entries: [] };
  }
}

/** verarbeitet eine manifest-datei: prüfungen in originalreihenfolge
 *  (dateiname → lesen → parsen → appid-abgleich → duplikat). liefert die
 *  geparsten felder oder `null`, wenn der eintrag übersprungen wird. die
 *  manifest-fehler laufen alle über `failManifest`, den einen platz für form
 *  und zähler (INV-2). */
async function readManifestFile(
  fs: Ports["fs"],
  lib: string,
  appsDir: string,
  entryName: string,
  seenManifests: Map<number, { library: string; manifestPath: string }>,
  cleanupUnsafeLibraries: Set<string>,
  warnings: ScanWarning[],
  counts: ReadFailedCounts,
): Promise<ManifestData | null> {
  // ein fehlgeschlagenes manifest erzeugt immer dieselbe form: library fürs
  // cleanup sperren, zähler hoch, warnung mit grund (INV-2). Fünf
  // aufrufstellen, ein platz für form und zähler.
  const failManifest = (
    manifestName: string,
    reason: Extract<ScanWarning, { type: "manifest" }>["reason"],
    detail: string,
    appId?: number,
  ): void => {
    cleanupUnsafeLibraries.add(lib);
    counts.failed += 1;
    warnings.push({ type: "manifest", library: lib, manifestName, appId, reason, detail });
  };

  const m = MANIFEST_RE.exec(entryName);
  if (!m) return null;

  const manifestPath = joinPath(appsDir, entryName);
  // der leere string deckt den typgetriebenen Fall ab (`m[1]` ist durch
  // noUncheckedIndexedAccess `string | undefined`); parseSafeAppId weist
  // ihn ohnehin ab und liefert null.
  const filenameAppId = parseSafeAppId(m[1] ?? "");
  if (filenameAppId === null) {
    failManifest(entryName, "invalid-filename", "invalid appid in filename");
    return null;
  }

  let text: string;
  try {
    text = await fs.readTextFile(manifestPath);
  } catch (e) {
    failManifest(entryName, "unreadable", errText(e), filenameAppId);
    return null;
  }

  let data: ManifestData;
  try {
    data = parseManifest(text);
  } catch (e) {
    failManifest(entryName, "invalid-content", errText(e), filenameAppId);
    return null;
  }

  if (data.appId !== filenameAppId) {
    failManifest(
      entryName,
      "appid-mismatch",
      `filename ${filenameAppId} vs vdf ${data.appId}`,
      data.appId,
    );
    return null;
  }

  const existing = seenManifests.get(data.appId);
  if (existing) {
    // beide beteiligten libraries sperren: der duplikat-konflikt trifft
    // auch die zuerst gesehene library.
    cleanupUnsafeLibraries.add(existing.library);
    failManifest(
      entryName,
      "duplicate",
      `"${manifestPath}" collides with "${existing.manifestPath}"`,
      data.appId,
    );
    return null;
  }

  seenManifests.set(data.appId, { library: lib, manifestPath });
  counts.read += 1;
  return data;
}

/** blocklist-prüfung: die exakte id verwirft das spiel still, die
 *  namens-heuristik meldet nur. liefert `true`, wenn das spiel verworfen wird. */
function dropBlockedGame(
  warnings: ScanWarning[],
  blockedAppIds: Set<number>,
  lib: string,
  manifestName: string,
  data: ManifestData,
): boolean {
  const block = blockReason(data.appId, data.name);
  if (block === "id") {
    blockedAppIds.add(data.appId);
    return true;
  }
  if (block === "name-heuristic") {
    // namens-präfix ist keine gewissheit: ein echtes spiel (z. B.
    // "Proton Pulse") darf nicht still aus der library verschwinden.
    // melden statt filtern; die exakte-id-tabelle bleibt der filter.
    warnings.push({
      type: "manifest",
      library: lib,
      manifestName,
      appId: data.appId,
      reason: "name-heuristic",
      detail: `"${data.name}" carries a valve package name but the appid is not blocklisted`,
    });
  }
  return false;
}

/** baut das angereicherte `Game` aus manifest und localconfig. die
 *  auswertungsreihenfolge der felder bleibt erhalten (compatFor vor der
 *  header-auflösung). */
async function buildGame(
  fs: Ports["fs"],
  steamRoot: string,
  compatFor: CompatFor,
  lib: string,
  data: ManifestData,
  apps: LocalConfigApps | null,
): Promise<Game> {
  const launchOptions = apps?.launchOptions.get(data.appId);
  const lastPlayed = parseLastPlayed(apps?.lastPlayed.get(data.appId));
  return {
    appId: data.appId,
    name: data.name,
    library: lib,
    sizeBytes: data.sizeBytes,
    installdir: data.installdir,
    ...compatFor(data.appId),
    protonDb: null,
    localHeader: await resolveLocalHeader(fs, steamRoot, data.appId),
    headerImage: paths.headerImageUrl(data.appId),
    launchOptions,
    lastPlayed,
  };
}

export async function scanGames(
  fs: Ports["fs"],
  steamRoot: string,
  libraries: string[],
  compatFor: CompatFor,
  localConfigText: string | null,
): Promise<ScanGamesResult> {
  const warnings: ScanWarning[] = [];
  const skippedLibraries: SkippedLibrary[] = [];
  const cleanupUnsafeLibraries = new Set<string>();
  const games: Game[] = [];
  const blockedAppIds = new Set<number>();
  const seenManifests = new Map<number, { library: string; manifestPath: string }>();
  const manifestCounts: ReadFailedCounts = { read: 0, failed: 0 };
  let localConfigDegraded: string | null = null;
  // ein tokenize für alle spiele; ein lexikalischer defekt wirft hier einmal
  // (config.ts fängt ihn vorab, der direkte aufruf degradiert ebenfalls).
  let apps: LocalConfigApps | null = null;
  if (localConfigText) {
    try {
      apps = readAppFields(localConfigText);
      if (apps.firstError !== null) localConfigDegraded = apps.firstError;
    } catch (e) {
      localConfigDegraded = errText(e);
    }
  }

  for (const lib of libraries) {
    const { appsDir, entries } = await readLibraryEntries(fs, lib, warnings, skippedLibraries);
    for (const entry of entries) {
      const data = await readManifestFile(
        fs,
        lib,
        appsDir,
        entry.name,
        seenManifests,
        cleanupUnsafeLibraries,
        warnings,
        manifestCounts,
      );
      if (data === null) continue;
      if (dropBlockedGame(warnings, blockedAppIds, lib, entry.name, data)) continue;
      games.push(await buildGame(fs, steamRoot, compatFor, lib, data, apps));
    }
  }

  return {
    games,
    blockedAppIds,
    warnings,
    skippedLibraries,
    cleanupUnsafeLibraries: [...cleanupUnsafeLibraries],
    manifestCounts,
    localConfigDegraded,
  };
}
