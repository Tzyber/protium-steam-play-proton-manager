import { isBlocked } from "../blocklist.js";
import { errText } from "../errtext.js";
import { readLaunchOptions } from "../localconfig.js";
import { parseManifest } from "../manifest.js";
import { joinPath, LOCAL_HEADER_FILENAME, paths } from "../paths.js";
import type { DirEntry, Ports } from "../ports.js";
import type { Game, SkippedLibrary } from "../types.js";

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

export async function scanGames(
  fs: Ports["fs"],
  system: Ports["system"],
  steamRoot: string,
  libraries: string[],
  compatFor: (appId: number) => string,
  localConfigText: string | null,
): Promise<{
  games: Game[];
  blockedAppIds: Set<number>;
  warnings: string[];
  skippedLibraries: SkippedLibrary[];
}> {
  const warnings: string[] = [];
  const skippedLibraries: SkippedLibrary[] = [];
  const games: Game[] = [];
  const blockedAppIds = new Set<number>();
  for (const lib of libraries) {
    try {
      await system.allowLibraryScope(lib); // Externe Mounts vor dem Lesen freigeben.
    } catch (e) {
      warnings.push(`library "${lib}" nicht scope-bar, übersprungen: ${errText(e)}`);
      skippedLibraries.push({ path: lib, reason: "scope-failed" });
      continue;
    }
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
      try {
        // entry.name statt pfad-neukonstruktion: ein dateiname wie
        // appmanifest_042.acf (führende null) würde sonst als _42 gelesen → throw.
        const data = parseManifest(await fs.readTextFile(joinPath(appsDir, entry.name)));
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
        warnings.push(`${entry.name} übersprungen: ${errText(e)}`);
      }
    }
  }

  return { games, blockedAppIds, warnings, skippedLibraries };
}
