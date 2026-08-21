import { isBlocked } from "../blocklist.js";
import { errText } from "../errtext.js";
import { readLaunchOptions } from "../localconfig.js";
import { parseManifest } from "../manifest.js";
import { joinPath, LOCAL_HEADER_FILENAME, paths } from "../paths.js";
import type { DirEntry, Ports } from "../ports.js";
import { type Game, parseSafeAppId, type SkippedLibrary } from "../types.js";

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
  warnings: string[];
  skippedLibraries: SkippedLibrary[];
  cleanupUnsafeLibraries: string[];
}

export async function scanGames(
  fs: Ports["fs"],
  _system: Ports["system"],
  steamRoot: string,
  libraries: string[],
  compatFor: (appId: number) => string,
  localConfigText: string | null,
): Promise<ScanGamesResult> {
  const warnings: string[] = [];
  const skippedLibraries: SkippedLibrary[] = [];
  const cleanupUnsafeLibraries = new Set<string>();
  const games: Game[] = [];
  const blockedAppIds = new Set<number>();
  const seenManifests = new Map<number, { library: string; manifestPath: string }>();

  for (const lib of libraries) {
    const appsDir = paths.libraryAppsDir(lib);
    let entries: DirEntry[];
    try {
      if (!(await fs.exists(appsDir))) continue;
      entries = await fs.readDir(appsDir);
    } catch (e) {
      warnings.push(`library "${lib}" nicht lesbar: ${errText(e)}`);
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
        warnings.push(`${entry.name} übersprungen: ungültige appid im dateinamen`);
        continue;
      }

      try {
        const data = parseManifest(await fs.readTextFile(manifestPath));
        if (data.appId !== filenameAppId) {
          cleanupUnsafeLibraries.add(lib);
          warnings.push(
            `${entry.name} übersprungen: appid-mismatch (dateiname ${filenameAppId} vs vdf ${data.appId})`,
          );
          continue;
        }

        const existing = seenManifests.get(data.appId);
        if (existing) {
          cleanupUnsafeLibraries.add(lib);
          cleanupUnsafeLibraries.add(existing.library);
          warnings.push(
            `doppelte appid ${data.appId} übersprungen: "${manifestPath}" kollidiert mit "${existing.manifestPath}"`,
          );
          continue;
        }

        seenManifests.set(data.appId, { library: lib, manifestPath });

        if (isBlocked(data.appId, data.name)) {
          blockedAppIds.add(data.appId);
          continue;
        }
        games.push({
          appId: data.appId,
          name: data.name,
          library: lib,
          sizeBytes: data.sizeBytes,
          compatTool: compatFor(data.appId),
          protonDb: null,
          localHeader: await resolveLocalHeader(fs, steamRoot, data.appId),
          headerImage: paths.headerImageUrl(data.appId),
          launchOptions: localConfigText
            ? readLaunchOptions(localConfigText, data.appId)
            : undefined,
        });
      } catch (e) {
        cleanupUnsafeLibraries.add(lib);
        warnings.push(`${entry.name} übersprungen: ${errText(e)}`);
      }
    }
  }

  return {
    games,
    blockedAppIds,
    warnings,
    skippedLibraries,
    cleanupUnsafeLibraries: [...cleanupUnsafeLibraries],
  };
}
