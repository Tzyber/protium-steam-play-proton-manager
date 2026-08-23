import type { ScanResult } from "./types.js";

export type ProtonCheckReason = "tier-bronze" | "tier-borked" | "tool-not-recognized";

export interface ProtonCheck {
  appId: number;
  reasons: ProtonCheckReason[];
}

type ProtonCheckInput = Pick<
  ScanResult,
  "games" | "compatToolsInstalled" | "builtinProtonsInstalled"
>;

export function deriveProtonCheck(result: ProtonCheckInput): ProtonCheck[] {
  const customNames = new Set<string>();
  for (const tool of result.compatToolsInstalled) {
    customNames.add(tool.internalName);
    customNames.add(tool.name);
  }
  const builtinNames = new Set(result.builtinProtonsInstalled.map((tool) => tool.internalName));

  return result.games.flatMap((game) => {
    const reasons: ProtonCheckReason[] = [];
    if (game.protonDb?.tier === "bronze") reasons.push("tier-bronze");
    if (game.protonDb?.tier === "borked") reasons.push("tier-borked");

    if (
      game.compatToolSource === "explicit" &&
      !customNames.has(game.compatTool) &&
      !builtinNames.has(game.compatTool)
    ) {
      reasons.push("tool-not-recognized");
    }

    return reasons.length > 0 ? [{ appId: game.appId, reasons }] : [];
  });
}
