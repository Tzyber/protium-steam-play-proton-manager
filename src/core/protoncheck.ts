import { availableRuntimes, isManifestToolName } from "./blocklist.js";
import type { ScanResult, ScanWarning } from "./types.js";

type ProtonCheckReason = "tier-bronze" | "tier-borked" | "tool-not-recognized";

export interface ProtonCheck {
  appId: number;
  reasons: ProtonCheckReason[];
}

type ProtonCheckInput = Pick<
  ScanResult,
  "games" | "compatToolsInstalled" | "builtinProtonsInstalled" | "warnings" | "blockedAppIds"
>;

type ToolInventory = Pick<
  ScanResult,
  "compatToolsInstalled" | "builtinProtonsInstalled" | "blockedAppIds"
>;

/** Positive Präsenz: Custom-Tools, Builtin-Protons und Runtime-Namen, deren
 *  App-Manifest im Scan liegt. */
function presentToolNames(result: ToolInventory): Set<string> {
  const names = new Set(availableRuntimes(new Set(result.blockedAppIds)).keys());
  for (const tool of result.compatToolsInstalled) {
    names.add(tool.internalName);
    names.add(tool.name);
  }
  for (const tool of result.builtinProtonsInstalled) names.add(tool.internalName);
  return names;
}

export function isCompatToolPresent(result: ToolInventory, compatTool: string): boolean {
  return presentToolNames(result).has(compatTool);
}

/** true, wenn der Tool-Scan die Abwesenheit von `compatTool` nicht sicher
 *  beweisen kann. Nur strukturierte ScanWarning-Daten, keine Text-Heuristik.
 *  size-unreadable unterdrückt nie: das Tool bleibt im Inventar (Präsenz
 *  vollständig, nur die Größe fehlt). */
function toolAbsenceUncertain(warnings: ScanWarning[], compatTool: string): boolean {
  return warnings.some((warning) => {
    if (
      warning.type === "library" ||
      (warning.type === "manifest" && warning.reason !== "name-heuristic")
    ) {
      // eine übersprungene library oder ein gescheitertes manifest kann das
      // app-manifest des gemappten builtins oder der runtime verbergen. ein
      // name-heuristic-treffer ist gelesen und hat keine blocklistete appid.
      return isManifestToolName(compatTool);
    }
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
  const presentNames = presentToolNames(result);

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
      !presentNames.has(game.compatTool)
    ) {
      reasons.push("tool-not-recognized");
    }

    return reasons.length > 0 ? [{ appId: game.appId, reasons }] : [];
  });
}
