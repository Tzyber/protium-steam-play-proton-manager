import type { ScanResult, ScanWarning } from "./types.js";

export type ProtonCheckReason = "tier-bronze" | "tier-borked" | "tool-not-recognized";

export interface ProtonCheck {
  appId: number;
  reasons: ProtonCheckReason[];
}

type ProtonCheckInput = Pick<
  ScanResult,
  "games" | "compatToolsInstalled" | "builtinProtonsInstalled" | "warnings"
>;

type ToolInventory = Pick<ScanResult, "compatToolsInstalled" | "builtinProtonsInstalled">;

function toolPresenceSets(result: ToolInventory): {
  customNames: Set<string>;
  builtinNames: Set<string>;
} {
  const customNames = new Set<string>();
  for (const tool of result.compatToolsInstalled) {
    customNames.add(tool.internalName);
    customNames.add(tool.name);
  }
  return {
    customNames,
    builtinNames: new Set(result.builtinProtonsInstalled.map((tool) => tool.internalName)),
  };
}

/** Prüft nur positive Präsenz im vorhandenen Custom-/Builtin-Inventar. */
export function isCompatToolPresent(result: ToolInventory, compatTool: string): boolean {
  const { customNames, builtinNames } = toolPresenceSets(result);
  return customNames.has(compatTool) || builtinNames.has(compatTool);
}

/** true, wenn der Tool-Scan die Abwesenheit von `compatTool` nicht sicher
 *  beweisen kann. Nur strukturierte ScanWarning-Daten, keine Text-Heuristik.
 *  size-unreadable unterdrückt nie: das Tool bleibt im Inventar (Präsenz
 *  vollständig, nur die Größe fehlt). */
function toolAbsenceUncertain(warnings: ScanWarning[], compatTool: string): boolean {
  return warnings.some((warning) => {
    if (warning.type !== "compat-tool") return false;
    if (warning.reason === "directory-unreadable" || warning.reason === "path-identity") {
      // das verzeichnis ist unbekannt: das gemappte tool könnte darin liegen
      return true;
    }
    if (warning.reason === "vdf-unreadable" || warning.reason === "vdf-invalid") {
      // der internalName des eintrags ist unbekannt und könnte das gemappte tool sein
      return true;
    }
    if (warning.reason === "symlink") {
      return warning.toolName === compatTool;
    }
    return false;
  });
}

export function deriveProtonCheck(result: ProtonCheckInput): ProtonCheck[] {
  const { customNames, builtinNames } = toolPresenceSets(result);

  return result.games.flatMap((game) => {
    const reasons: ProtonCheckReason[] = [];
    if (game.protonDb?.tier === "bronze") reasons.push("tier-bronze");
    if (game.protonDb?.tier === "borked") reasons.push("tier-borked");

    // tool-not-recognized ist eine Abwesenheitsbehauptung: nur erlaubt, wenn
    // der Tool-Scan sie sicher beweist. Lieber kein Check als ein False
    // Positive (fail-closed).
    if (
      game.compatToolSource === "explicit" &&
      !toolAbsenceUncertain(result.warnings, game.compatTool) &&
      !customNames.has(game.compatTool) &&
      !builtinNames.has(game.compatTool)
    ) {
      reasons.push("tool-not-recognized");
    }

    return reasons.length > 0 ? [{ appId: game.appId, reasons }] : [];
  });
}
