import type { EnvironmentSnapshot, Ports } from "../ports.js";
import type { ScanResult } from "../types.js";
import { readCompatMapping, readLaunchConfig } from "./config.js";
import { scanGames } from "./games.js";
import { readLibraryList } from "./libraries.js";
import { readCompatTools } from "./tools.js";

export async function scanLocal(
  ports: Ports,
  environment: EnvironmentSnapshot,
): Promise<Omit<ScanResult, "steamRoot">> {
  const { fs, system } = ports;
  const { steamRoot } = environment;
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

  return {
    libraries: libraryResult.libraries,
    games: gamesResult.games,
    compatToolsInstalled: toolsResult.compatToolsInstalled,
    builtinProtonsInstalled: toolsResult.builtinProtonsInstalled,
    defaultCompatTool: toolsResult.defaultCompatTool,
    compatConfigStatus: mappingResult.compatConfigStatus,
    steamUserId: launchResult.steamUserId,
    launchConfigStatus: launchResult.launchConfigStatus,
    manifestCounts: gamesResult.manifestCounts,
    compatToolCounts: toolsResult.compatToolCounts,
    blockedAppIds: [...gamesResult.blockedAppIds],
    warnings: [
      ...libraryResult.warnings,
      ...mappingResult.warnings,
      ...launchResult.warnings,
      ...gamesResult.warnings,
      ...toolsResult.warnings,
    ],
    skippedLibraries: [...libraryResult.skippedLibraries, ...gamesResult.skippedLibraries],
    cleanupUnsafeLibraries: gamesResult.cleanupUnsafeLibraries,
  };
}
