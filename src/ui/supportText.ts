import type { SupportFacts } from "../core/support.js";
import { formatBytes } from "./format.js";
import { t } from "./i18n/index.js";

function configStatusLabel(status: SupportFacts["compatConfigStatus"]): string {
  switch (status) {
    case "available":
      return t("support.toolAvailable");
    case "missing":
      return t("support.statusMissing");
    case "unreadable":
      return t("support.statusUnreadable");
    default:
      return t("support.unknown");
  }
}

function launchStatusLabel(status: SupportFacts["launchConfigStatus"]): string {
  switch (status) {
    case "available":
      return t("support.toolAvailable");
    case "missing":
      return t("support.statusMissing");
    case "unreadable":
      return t("support.statusUnreadable");
    case "ambiguous":
      return t("support.statusAmbiguous");
    default:
      return t("support.unknown");
  }
}

function coverageLabel(state: SupportFacts["scanCoverage"]): string {
  switch (state) {
    case "complete":
      return t("support.coverageComplete");
    case "incomplete":
      return t("support.coverageIncomplete");
    case "limited":
      return t("support.coverageLimited");
  }
}

function assignmentSourceLabel(source: SupportFacts["compatToolSource"]): string {
  switch (source) {
    case "explicit":
      return t("support.assignmentExplicit");
    case "default":
      return t("support.assignmentDefault");
    case "unavailable":
      return t("support.assignmentUnavailable");
  }
}

function toolAvailabilityLabel(availability: SupportFacts["compatToolAvailability"]): string {
  switch (availability) {
    case "available":
      return t("support.toolAvailable");
    case "not-recognized":
      return t("support.toolNotRecognized");
    case "unknown":
      return t("support.unknown");
  }
}

function tierLabel(tier: SupportFacts["protonDbTier"]): string {
  return tier === "unknown" ? t("support.unknown") : tier;
}

function formatKnownBytes(sizeBytes: number): string {
  return sizeBytes === 0 ? "0 B" : formatBytes(sizeBytes);
}

function footprintLine(facts: SupportFacts): string {
  const { status, sizeBytes } = facts.footprint;
  if (status === "complete" && sizeBytes !== undefined) {
    return t("support.footprintComplete", { size: formatKnownBytes(sizeBytes) });
  }
  if (status === "partial" && sizeBytes !== undefined) {
    return t("support.footprintPartial", { size: formatKnownBytes(sizeBytes) });
  }
  return t("support.footprintNotMeasured");
}

function cleanupLines(facts: SupportFacts): string[] {
  const lines = [t("support.cleanupDisplayedState")];
  const cleanup = facts.cleanup;
  if (cleanup.scanInProgress) lines.push(t("support.cleanupCheckInProgress"));

  const blockedAreas: readonly [boolean, string][] = [
    [cleanup.prefixUnavailable, t("support.cleanupAreaPrefix")],
    [cleanup.shaderUnavailable, t("support.cleanupAreaShader")],
    [cleanup.trashUnavailable, t("support.cleanupAreaTrash")],
  ];
  let hasBlockade = false;
  for (const [blocked, area] of blockedAreas) {
    if (!blocked) continue;
    hasBlockade = true;
    lines.push(t("support.cleanupBlocked", { area }));
  }

  if (cleanup.incompleteDeletionsCount !== null && cleanup.incompleteDeletionsCount > 0) {
    lines.push(
      t("support.cleanupIncompleteDeletion", {
        n: cleanup.incompleteDeletionsCount,
      }),
    );
  } else {
    lines.push(t("support.cleanupIncompleteDeletionUnknown"));
  }
  if (cleanup.incompleteDeletionsUnreadable) {
    lines.push(t("support.cleanupClaimCheckIncomplete"));
  }
  if (!hasBlockade) lines.push(t("support.cleanupClearanceUnknown"));
  return lines;
}

export function formatSupportFacts(facts: SupportFacts, appVersion: string): string {
  const lines = [
    t("support.product", { version: appVersion }),
    t("support.appId", { value: facts.appId ?? t("support.unknown") }),
    t("support.library", { value: facts.library ?? t("support.unknown") }),
    t("support.scanCoverage", { state: coverageLabel(facts.scanCoverage) }),
    t("support.config", { status: configStatusLabel(facts.compatConfigStatus) }),
    t("support.launchConfig", { status: launchStatusLabel(facts.launchConfigStatus) }),
    t("support.assignmentSource", { source: assignmentSourceLabel(facts.compatToolSource) }),
    t("support.assignedTool", {
      tool: facts.compatToolAlias ?? t("support.unknown"),
    }),
    t("support.toolAvailability", {
      status: toolAvailabilityLabel(facts.compatToolAvailability),
    }),
    t("support.protonDb", { tier: tierLabel(facts.protonDbTier) }),
    footprintLine(facts),
    facts.externalCompatdata === "detected"
      ? t("support.externalCompatdataDetected")
      : t("support.externalCompatdataUnknown"),
    ...cleanupLines(facts),
    t("support.anonymized"),
  ];
  return lines.join("\n");
}
