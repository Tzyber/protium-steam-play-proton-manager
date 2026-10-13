// Reine Ableitungen des GameDetailDrawers (R-05): Text-, Options- und
// Thema-Bildung ohne refs, Stores oder Mutationen, damit sie einzeln prüfbar
// bleiben. Der Drawer bindet sie über `computed(() => fn(...))` an seine
// reaktiven Quellen.

import { availableRuntimes } from "../core/blocklist";
import { analyzeLaunchOptions, type LaunchHint } from "../core/launchHints";
import type { Game, ScanResult } from "../core/types";
import type { SaveState } from "./composables/useGameConfigSave";
import type { ExplainTopic } from "./explain";
import { t } from "./i18n";

export function launchHintText(hint: LaunchHint): string {
  switch (hint) {
    case "gamemode-missing-command":
      return t("drawer.launchHintGamemodeMissingCommand");
    case "assignment-after-command":
      return t("drawer.launchHintAssignmentAfterCommand");
    case "assignment-without-command":
      return t("drawer.launchHintAssignmentWithoutCommand");
    case "proton-log-enabled":
      return t("drawer.launchHintProtonLogEnabled");
  }
}

export function launchHints(
  launchInput: string,
  game: Game | null,
  result: ScanResult | null,
  status: string,
): string[] {
  if (!game || !result || status !== "done" || result.launchConfigStatus !== "available") {
    return [];
  }
  return analyzeLaunchOptions(launchInput).map(launchHintText);
}

export function launchConfigUnavailable(result: ScanResult | null): boolean {
  return result?.launchConfigStatus !== undefined && result.launchConfigStatus !== "available";
}

export function compatProvenance(result: ScanResult | null, game: Game | null): string {
  if (!result || !game) return "";

  if (result.compatConfigStatus === "missing") return t("drawer.compatProvenanceMissing");
  if (result.compatConfigStatus === "unreadable") return t("drawer.compatProvenanceUnreadable");
  if (game.compatToolSource === "explicit") {
    return t("drawer.compatProvenanceExplicit", { name: game.compatTool });
  }
  if (game.compatToolSource === "default" && result.defaultCompatTool !== null) {
    return t("drawer.compatProvenanceDefault", { name: result.defaultCompatTool });
  }
  return t("drawer.compatProvenanceNoDefault");
}

export function compatToolUnrecognized(
  game: Game | null,
  protonChecks: readonly { appId: number; reasons: readonly string[] }[],
): boolean {
  return protonChecks.some(
    (check) => check.appId === game?.appId && check.reasons.includes("tool-not-recognized"),
  );
}

export function configTopics(
  result: ScanResult | null,
  game: Game | null,
  compatToolUnrecognized: boolean,
): ExplainTopic[] {
  const topics: ExplainTopic[] = ["compat-tool", "compat-source"];
  const status = result?.compatConfigStatus;
  if (status === "missing" || status === "unreadable") topics.push("config-unavailable");
  if (game?.compatToolSource === "default" && result?.defaultCompatTool) {
    topics.push("global-default");
  }
  if (compatToolUnrecognized) topics.push("tool-unrecognized");
  return topics;
}

export function footprintTopics(externalCompatdata: boolean | undefined): ExplainTopic[] {
  return externalCompatdata ? ["footprint", "external-compatdata"] : ["footprint"];
}

export function compatOptions(
  result: ScanResult | null,
  game: Game | null,
): { value: string; label: string }[] {
  const builtIns = result?.builtinProtonsInstalled ?? [];
  const tools = result?.compatToolsInstalled ?? [];
  const current = game?.compatTool ?? "";
  const list: { value: string; label: string }[] = [];

  const seen = new Set<string>(["__default__"]);
  list.push({ value: "__default__", label: t("drawer.compatDefault") });

  for (const tool of builtIns) {
    if (seen.has(tool.internalName)) continue;
    seen.add(tool.internalName);
    list.push({ value: tool.internalName, label: tool.displayName });
  }

  for (const tool of tools) {
    if (seen.has(tool.internalName)) continue;
    seen.add(tool.internalName);
    list.push({ value: tool.internalName, label: tool.displayName });
  }

  const customToolByDirectory = new Map(tools.map((tool) => [tool.name, tool]));
  if (
    current &&
    current !== "default" &&
    game?.compatToolSource === "explicit" &&
    !seen.has(current)
  ) {
    const customTool = customToolByDirectory.get(current);
    const runtimeLabel = availableRuntimes(new Set(result?.blockedAppIds)).get(current);
    list.push({
      value: current,
      label:
        customTool?.displayName ?? runtimeLabel ?? t("drawer.notRecognized", { name: current }),
    });
  }

  return list;
}

/** derselbe knopftext für beide speicherpfade. */
export function saveLabel(state: SaveState): string {
  return state.kind === "saving"
    ? "…"
    : state.kind === "saved"
      ? t("drawer.saved")
      : t("drawer.save");
}
