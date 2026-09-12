import type { EnvironmentSnapshot, Ports } from "../ports.js";
import type { ScanResult, ScanWarning } from "../types.js";
import { localConfigBrokenWarning, readCompatMapping, readLaunchConfig } from "./config.js";
import { scanGames } from "./games.js";
import { readLibraryList } from "./libraries.js";
import { readCompatTools } from "./tools.js";

export async function scanLocal(
  ports: Ports,
  environment: EnvironmentSnapshot,
): Promise<Omit<ScanResult, "steamRoot">> {
  const { fs, system } = ports;
  const { steamRoot } = environment;
  // INV-7: alle pfade dieses scans hängen an der wurzel; ein snapshot ohne
  // aktuelle wurzel darf nicht in einen lesepfad münden. die prüfung liegt
  // hier, weil dieser einstieg der einzige produktive ist.
  if (
    environment.generation < 1 ||
    steamRoot.length === 0 ||
    !environment.libraries.includes(steamRoot)
  ) {
    throw new Error("environment snapshot is missing a current Steam root");
  }
  const libraryResult = readLibraryList(environment);
  const mappingResult = await readCompatMapping(fs, steamRoot);
  const launchResult = await readLaunchConfig(fs, steamRoot);
  const compatFor = (appId: number) => {
    if (mappingResult.compatConfigStatus !== "available") {
      return { compatTool: "unknown", compatToolSource: "unavailable" as const };
    }
    const explicit = mappingResult.mapping.get(appId);
    if (explicit !== undefined) {
      return { compatTool: explicit, compatToolSource: "explicit" as const };
    }
    return {
      compatTool: "default",
      compatToolSource: mappingResult.mapping.has(0)
        ? ("default" as const)
        : ("unavailable" as const),
    };
  };
  const gamesResult = await scanGames(
    fs,
    steamRoot,
    libraryResult.libraries,
    compatFor,
    launchResult.localConfigText,
  );
  const toolsResult = await readCompatTools(
    fs,
    system,
    steamRoot,
    mappingResult.mapping,
    gamesResult.blockedAppIds,
    gamesResult.games,
    environment.systemCompatDirs,
  );
  // ein erst beim per-spiel-read sichtbarer strukturschaden der localconfig
  // degradiert den status scan-weit; die warnung entsteht genau einmal hier,
  // damit sie nicht pro spiel wiederholt wird (INV-2).
  const localConfigDegraded = gamesResult.localConfigDegraded;
  const launchWarnings: ScanWarning[] =
    localConfigDegraded === null
      ? launchResult.warnings
      : [
          ...launchResult.warnings,
          localConfigBrokenWarning(localConfigDegraded, launchResult.steamUserId),
        ];

  return {
    libraries: libraryResult.libraries,
    games: gamesResult.games,
    compatToolsInstalled: toolsResult.compatToolsInstalled,
    builtinProtonsInstalled: toolsResult.builtinProtonsInstalled,
    defaultCompatTool: toolsResult.defaultCompatTool,
    compatConfigStatus: mappingResult.compatConfigStatus,
    steamUserId: launchResult.steamUserId,
    launchConfigStatus:
      localConfigDegraded === null ? launchResult.launchConfigStatus : "unreadable",
    manifestCounts: gamesResult.manifestCounts,
    compatToolCounts: toolsResult.compatToolCounts,
    blockedAppIds: [...gamesResult.blockedAppIds],
    warnings: [
      ...libraryResult.warnings,
      ...mappingResult.warnings,
      ...launchWarnings,
      ...gamesResult.warnings,
      ...toolsResult.warnings,
    ],
    skippedLibraries: [...libraryResult.skippedLibraries, ...gamesResult.skippedLibraries],
    cleanupUnsafeLibraries: gamesResult.cleanupUnsafeLibraries,
  };
}
