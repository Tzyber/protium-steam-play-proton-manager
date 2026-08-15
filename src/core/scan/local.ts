import type { Ports } from "../ports.js";
import type { ScanResult } from "../types.js";
import { readCompatMapping, readLaunchConfig } from "./config.js";
import { scanGames } from "./games.js";
import { readLibraryList } from "./libraries.js";
import { readCompatTools } from "./tools.js";

export async function scanLocal(
  ports: Ports,
  steamRoot: string,
  extraCompatDirs: readonly string[] | undefined,
): Promise<Omit<ScanResult, "steamRoot">> {
  const { fs, system } = ports;
  const libraryResult = await readLibraryList(fs, system, steamRoot);
  const mappingResult = await readCompatMapping(fs, steamRoot);
  const launchResult = await readLaunchConfig(fs, steamRoot);
  const compatFor = (appId: number): string =>
    !mappingResult.mappingUsable ? "unknown" : (mappingResult.mapping.get(appId) ?? "default");
  const gamesResult = await scanGames(
    fs,
    system,
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
    extraCompatDirs,
  );

  return {
    libraries: libraryResult.libraries,
    games: gamesResult.games,
    compatToolsInstalled: toolsResult.compatToolsInstalled,
    builtinProtonsInstalled: toolsResult.builtinProtonsInstalled,
    defaultCompatTool: toolsResult.defaultCompatTool,
    steamUserId: launchResult.steamUserId,
    warnings: [
      ...libraryResult.warnings,
      ...mappingResult.warnings,
      ...launchResult.warnings,
      ...gamesResult.warnings,
      ...toolsResult.warnings,
    ],
    skippedLibraries: [...libraryResult.skippedLibraries, ...gamesResult.skippedLibraries],
  };
}
