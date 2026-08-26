import { isBlocked } from "../blocklist.js";
import { errText } from "../errtext.js";
import { readLaunchOptions } from "../localconfig.js";
import { parseManifest } from "../manifest.js";
import { joinPath, LOCAL_HEADER_FILENAME, paths } from "../paths.js";
import type { DirEntry, Ports } from "../ports.js";
import {
  type CompatToolSource,
  type Game,
  parseSafeAppId,
  type ScanWarning,
  type SkippedLibrary,
} from "../types.js";

const MANIFEST_RE = /^appmanifest_(\d+)\.acf$/;

// cover liegt unter librarycache/{appId}/{hash}/, hash-unterordner muss durchsucht werden.
async function resolveLocalHeader(
  fs: Ports["fs"],
  steamRoot: string,
  appId: number,
): Promise<string | null> {
  const dir = paths.libraryCacheAppDir(steamRoot, appId);
  try {
    if (!(await fs.exists(dir))) return null;
    for (const entry of await fs.readDir(dir)) {
      if (!entry.isDirectory) continue;
      const candidate = joinPath(dir, entry.name, LOCAL_HEADER_FILENAME);
      if (await fs.exists(candidate)) return candidate;
    }
  } catch {
    // Defekte Cover-Dateien werden wie fehlende behandelt.
  }
  return null;
}

export interface ScanGamesResult {
  games: Game[];
  blockedAppIds: Set<number>;
  warnings: ScanWarning[];
  skippedLibraries: SkippedLibrary[];
  cleanupUnsafeLibraries: string[];
  manifestCounts: { read: number; failed: number };
}

export interface CompatAssignment {
  compatTool: string;
  compatToolSource: CompatToolSource;
}

type CompatFor = (appId: number) => CompatAssignment | string;

function resolveCompatAssignment(value: CompatAssignment | string): CompatAssignment {
  if (typeof value !== "string") return value;
  if (value === "unknown") return { compatTool: value, compatToolSource: "unavailable" };
  if (value === "default") return { compatTool: value, compatToolSource: "default" };
  return { compatTool: value, compatToolSource: "explicit" };
}

export async function scanGames(
  fs: Ports["fs"],
  _system: Ports["system"],
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
  let manifestRead = 0;
  let manifestFailed = 0;

  for (const lib of libraries) {
    const appsDir = paths.libraryAppsDir(lib);
    let entries: DirEntry[];
    try {
      if (!(await fs.exists(appsDir))) {
        warnings.push({
          type: "library",
          path: lib,
          reason: "path-missing",
          detail: `library "${lib}" fehlt: steamapps`,
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
        detail: `library "${lib}" nicht lesbar: ${errText(e)}`,
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
        cleanupUnsafeLibraries.add(lib);
        manifestFailed += 1;
        warnings.push({
          type: "manifest",
          library: lib,
          manifestName: entry.name,
          reason: "invalid-filename",
          detail: "ungültige appid im dateinamen",
        });
        continue;
      }

      let text: string;
      try {
        text = await fs.readTextFile(manifestPath);
      } catch (e) {
        cleanupUnsafeLibraries.add(lib);
        manifestFailed += 1;
        warnings.push({
          type: "manifest",
          library: lib,
          manifestName: entry.name,
          appId: filenameAppId,
          reason: "unreadable",
          detail: errText(e),
        });
        continue;
      }

      let data: ReturnType<typeof parseManifest>;
      try {
        data = parseManifest(text);
      } catch (e) {
        cleanupUnsafeLibraries.add(lib);
        manifestFailed += 1;
        warnings.push({
          type: "manifest",
          library: lib,
          manifestName: entry.name,
          appId: filenameAppId,
          reason: "invalid-content",
          detail: errText(e),
        });
        continue;
      }

      if (data.appId !== filenameAppId) {
        cleanupUnsafeLibraries.add(lib);
        manifestFailed += 1;
        warnings.push({
          type: "manifest",
          library: lib,
          manifestName: entry.name,
          appId: data.appId,
          reason: "appid-mismatch",
          detail: `dateiname ${filenameAppId} vs vdf ${data.appId}`,
        });
        continue;
      }

      const existing = seenManifests.get(data.appId);
      if (existing) {
        cleanupUnsafeLibraries.add(lib);
        cleanupUnsafeLibraries.add(existing.library);
        manifestFailed += 1;
        warnings.push({
          type: "manifest",
          library: lib,
          manifestName: entry.name,
          appId: data.appId,
          reason: "duplicate",
          detail: `"${manifestPath}" kollidiert mit "${existing.manifestPath}"`,
        });
        continue;
      }

      seenManifests.set(data.appId, { library: lib, manifestPath });
      manifestRead += 1;

      if (isBlocked(data.appId, data.name)) {
        blockedAppIds.add(data.appId);
        continue;
      }
      games.push({
        appId: data.appId,
        name: data.name,
        library: lib,
        sizeBytes: data.sizeBytes,
        ...resolveCompatAssignment(compatFor(data.appId)),
        protonDb: null,
        localHeader: await resolveLocalHeader(fs, steamRoot, data.appId),
        headerImage: paths.headerImageUrl(data.appId),
        launchOptions: localConfigText ? readLaunchOptions(localConfigText, data.appId) : undefined,
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
  };
}
