import { availableBuiltinProtons } from "../blocklist.js";
import { listCompatTools } from "../compat.js";
import type { CompatToolMapping } from "../compatTools.js";
import type { Ports } from "../ports.js";
import type { BuiltinProton, CompatTool, Game, ReadFailedCounts, ScanWarning } from "../types.js";

export async function readCompatTools(
  fs: Ports["fs"],
  system: Ports["system"],
  steamRoot: string,
  mapping: CompatToolMapping,
  blockedAppIds: ReadonlySet<number>,
  games: Game[],
  systemCompatDirs: readonly string[],
): Promise<{
  compatToolsInstalled: CompatTool[];
  builtinProtonsInstalled: BuiltinProton[];
  defaultCompatTool: string | null;
  compatToolCounts: ReadFailedCounts;
  warnings: ScanWarning[];
}> {
  const installedAppIds = new Set(games.map((g) => g.appId));
  const builtinProtonsInstalled = availableBuiltinProtons(blockedAppIds);
  const defaultCompatTool = mapping.get(0) ?? null; // mapping[0] = globaler default
  const toolResult = await listCompatTools(
    fs,
    system,
    steamRoot,
    mapping,
    installedAppIds,
    systemCompatDirs,
  );
  return {
    compatToolsInstalled: toolResult.tools,
    builtinProtonsInstalled,
    defaultCompatTool,
    compatToolCounts: toolResult.counts,
    warnings: toolResult.warnings,
  };
}
