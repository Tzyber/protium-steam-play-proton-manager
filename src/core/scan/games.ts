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

/** localconfig-rohwert → unix-sekunden; `"0"` und unsinn bleiben unbekannt. */
function parseLastPlayed(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
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
  // ein fehlgeschlagenes manifest erzeugt immer dieselbe form: library fürs
  // cleanup sperren, zähler hoch, warnung mit grund (INV-2). Fünf
  // aufrufstellen, ein platz für form und zähler.
  const failManifest = (
    lib: string,
    manifestName: string,
    reason: Extract<ScanWarning, { type: "manifest" }>["reason"],
    detail: string,
    appId?: number,
  ): void => {
    cleanupUnsafeLibraries.add(lib);
    manifestFailed += 1;
    warnings.push({ type: "manifest", library: lib, manifestName, appId, reason, detail });
  };
  const games: Game[] = [];
  const blockedAppIds = new Set<number>();
  const seenManifests = new Map<number, { library: string; manifestPath: string }>();
  let manifestRead = 0;
  let manifestFailed = 0;
  let localConfigDegraded: string | null = null;
  // ein tokenize für alle spiele; ein lexikalischer defekt wirft hier einmal
  // (config.ts fängt ihn vorab, der direkte aufruf degradiert ebenfalls).
  let apps: ReturnType<typeof readAppFields> | null = null;
  if (localConfigText) {
    try {
      apps = readAppFields(localConfigText);
      if (apps.firstError !== null) localConfigDegraded = apps.firstError;
    } catch (e) {
      localConfigDegraded = errText(e);
    }
  }

  for (const lib of libraries) {
    const appsDir = paths.libraryAppsDir(lib);
    let entries: DirEntry[];
    try {
      if (!(await fs.exists(appsDir))) {
        warnings.push({
          type: "library",
          path: lib,
          reason: "path-missing",
          detail: `library "${lib}" missing: steamapps`,
        });
        skippedLibraries.push({ path: lib, reason: "path-missing" });
        continue;
      }
      entries = await fs.readDir(appsDir);
    } catch (e) {
      warnings.push({
        type: "library",
        path: lib,
        reason: "read-failed",
        detail: `library "${lib}" not readable: ${errText(e)}`,
      });
      skippedLibraries.push({ path: lib, reason: "read-failed" });
      continue;
    }
    for (const entry of entries) {
      const m = MANIFEST_RE.exec(entry.name);
      if (!m) continue;

      const manifestPath = joinPath(appsDir, entry.name);
      const filenameRaw = m[1];
      const filenameAppId = filenameRaw ? parseSafeAppId(filenameRaw) : null;
      if (filenameAppId === null) {
        failManifest(lib, entry.name, "invalid-filename", "invalid appid in filename");
        continue;
      }

      let text: string;
      try {
        text = await fs.readTextFile(manifestPath);
      } catch (e) {
        failManifest(lib, entry.name, "unreadable", errText(e), filenameAppId);
        continue;
      }

      let data: ReturnType<typeof parseManifest>;
      try {
        data = parseManifest(text);
      } catch (e) {
        failManifest(lib, entry.name, "invalid-content", errText(e), filenameAppId);
        continue;
      }

      if (data.appId !== filenameAppId) {
        failManifest(
          lib,
          entry.name,
          "appid-mismatch",
          `filename ${filenameAppId} vs vdf ${data.appId}`,
          data.appId,
        );
        continue;
      }

      const existing = seenManifests.get(data.appId);
      if (existing) {
        // beide beteiligten libraries sperren: der duplikat-konflikt trifft
        // auch die zuerst gesehene library.
        cleanupUnsafeLibraries.add(existing.library);
        failManifest(
          lib,
          entry.name,
          "duplicate",
          `"${manifestPath}" collides with "${existing.manifestPath}"`,
          data.appId,
        );
        continue;
      }

      seenManifests.set(data.appId, { library: lib, manifestPath });
      manifestRead += 1;

      const block = blockReason(data.appId, data.name);
      if (block === "id") {
        blockedAppIds.add(data.appId);
        continue;
      }
      if (block === "name-heuristic") {
        // namens-präfix ist keine gewissheit: ein echtes spiel (z. b.
        // "Proton Pulse") darf nicht still aus der library verschwinden.
        // melden statt filtern; die exakte-id-tabelle bleibt der filter.
        warnings.push({
          type: "manifest",
          library: lib,
          manifestName: entry.name,
          appId: data.appId,
          reason: "name-heuristic",
          detail: `"${data.name}" carries a valve package name but the appid is not blocklisted`,
        });
      }
      const launchOptions = apps?.launchOptions.get(data.appId);
      const lastPlayed = parseLastPlayed(apps?.lastPlayed.get(data.appId));
      games.push({
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
      });
    }
  }

  return {
    games,
    blockedAppIds,
    warnings,
    skippedLibraries,
    cleanupUnsafeLibraries: [...cleanupUnsafeLibraries],
    manifestCounts: { read: manifestRead, failed: manifestFailed },
    localConfigDegraded,
  };
}
