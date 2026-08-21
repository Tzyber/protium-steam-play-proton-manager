import { availableBuiltinProtons } from "../blocklist.js";
import { type CompatToolMapping, listCompatTools } from "../compat.js";
import type { Ports } from "../ports.js";
import type { CompatTool, Game } from "../types.js";

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
  builtinProtonsInstalled: { internalName: string; displayName: string }[];
  defaultCompatTool: string | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
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
    systemCompatDirs,
  );
  return { compatToolsInstalled, builtinProtonsInstalled, defaultCompatTool, warnings };
}
