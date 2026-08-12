import { availableBuiltinProtons, isBlocked } from "./blocklist.js";
import { type CompatToolMapping, listCompatTools, parseCompatToolMapping } from "./compat.js";
import { errText } from "./errtext.js";
import { parseLibraryFolders } from "./libraryfolders.js";
import { findActiveUser, readLaunchOptions } from "./localconfig.js";
import { parseManifest } from "./manifest.js";
import { joinPath, LOCAL_HEADER_FILENAME, paths } from "./paths.js";
import type { DirEntry, Ports } from "./ports.js";
import { ProtonDbClient } from "./protondb.js";
import type { Game, ScanResult, SkippedLibrary } from "./types.js";

interface ScanOptions {
  steamRoot: string;
  protonDbDelayMs?: number;
  /** compat-dirs überschreiben, für tests. */
  extraCompatDirs?: readonly string[];
}

const MANIFEST_RE = /^appmanifest_(\d+)\.acf$/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
    // defekt → kein cover (INV-2)
  }
  return null;
}

// defekte dateien → skip+warning (INV-2), netzausfall → tier "unknown" (INV-3).
export async function scanLibrary(ports: Ports, opts: ScanOptions): Promise<ScanResult> {
  const { fs, system } = ports;
  const { steamRoot } = opts;
  const warnings: string[] = [];
  const skippedLibraries: SkippedLibrary[] = [];

  let libraries: string[] = [];
  try {
    const lfPath = paths.libraryFoldersVdf(steamRoot);
    if (await fs.exists(lfPath)) {
      libraries = parseLibraryFolders(await fs.readTextFile(lfPath));
    }
  } catch (e) {
    warnings.push(`libraryfolders.vdf nicht lesbar: ${errText(e)}`);
  }
  if (libraries.length === 0) libraries = [steamRoot]; // fallback: root ist selbst eine library

  // (dev,ino) fängt denselben datenträger über zwei mountpoints (z. B. /run/media vs /mnt).
  const uniqueLibraries: string[] = [];
  const seenIdentity = new Map<string, string>();
  for (const lib of libraries) {
    const id = await system.pathIdentity(lib);
    if (!id) {
      const exists = await fs.exists(lib);
      const reason = exists ? "scope-failed" : "path-missing";
      warnings.push(
        exists
          ? `library-pfad nicht erreichbar (identity-check fehlgeschlagen), übersprungen: ${lib}`
          : `library-pfad existiert nicht (tote config-leiche), übersprungen: ${lib}`,
      );
      skippedLibraries.push({ path: lib, reason });
      continue;
    }
    const key = `${id.dev}:${id.ino}`;
    const first = seenIdentity.get(key);
    if (first) {
      warnings.push(
        `library "${lib}" ist dieselbe wie "${first}" (identischer datenträger), übersprungen`,
      );
      continue;
    }
    seenIdentity.set(key, lib);
    uniqueLibraries.push(lib);
  }
  libraries = uniqueLibraries;

  let mapping: CompatToolMapping = new Map();
  let mappingUsable = true;
  try {
    const cfgPath = paths.configVdf(steamRoot);
    if (await fs.exists(cfgPath)) {
      mapping = parseCompatToolMapping(await fs.readTextFile(cfgPath));
    } else {
      mappingUsable = false;
      warnings.push("config.vdf fehlt → compat-tools als 'unknown' markiert");
    }
  } catch (e) {
    mappingUsable = false;
    warnings.push(`config.vdf nicht lesbar: ${errText(e)}`);
  }
  const compatFor = (appId: number): string =>
    !mappingUsable ? "unknown" : (mapping.get(appId) ?? "default");

  // startoptionen: aktiven account finden, localconfig einmal lesen (INV-2: defekt → leer)
  let steamUserId: string | null = null;
  let localConfigText: string | null = null;
  const activeUser = await findActiveUser(fs, steamRoot);
  if (!activeUser) {
    warnings.push("kein steam-account mit localconfig.vdf gefunden → startoptionen unbekannt");
  } else {
    steamUserId = activeUser.userId;
    if (activeUser.warning) warnings.push(activeUser.warning);
    try {
      localConfigText = await fs.readTextFile(paths.localConfigVdf(steamRoot, activeUser.userId));
    } catch (e) {
      warnings.push(`localconfig.vdf nicht lesbar: ${errText(e)}`);
    }
  }

  const games: Game[] = [];
  const blockedAppIds = new Set<number>();
  for (const lib of libraries) {
    try {
      await system.allowLibraryScope(lib); // externe mounts vor read freigeben (R-5)
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

  const installedAppIds = new Set(games.map((g) => g.appId));
  const builtinProtonsInstalled = availableBuiltinProtons(blockedAppIds);
  const defaultCompatTool = mapping.get(0) ?? null; // mapping[0] = globaler default
  const compatToolsInstalled = await listCompatTools(
    fs,
    system,
    steamRoot,
    mapping,
    warnings,
    installedAppIds,
    opts.extraCompatDirs,
  );

  const client = new ProtonDbClient(ports.http, ports.cache);
  const delay = opts.protonDbDelayMs ?? 150;
  for (const game of games) {
    game.protonDb = (await client.getSummary(game.appId)) ?? {
      tier: "unknown",
      confidence: "unknown",
    };
    if (delay > 0) await sleep(delay);
  }

  return {
    steamRoot,
    libraries,
    games,
    compatToolsInstalled,
    builtinProtonsInstalled,
    defaultCompatTool,
    steamUserId,
    warnings,
    skippedLibraries,
  };
}
