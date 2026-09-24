import type { SupportFacts } from "../core/support.js";
import { formatKnownBytes } from "./format.js";
import { t } from "./i18n/index.js";
import { tierText } from "./tier.js";

function configStatusLabel(
  status: Exclude<SupportFacts["launchConfigStatus"], "available">,
): string {
  switch (status) {
    case "missing":
      return t("support.statusMissing");
    case "unreadable":
      return t("support.statusUnreadable");
    case "ambiguous":
      return t("support.statusAmbiguous");
    // Der Zweig ist trotz erschöpfender Typen erreichbar: ein defektes
    // Scan-Ergebnis kann einen unbekannten Status tragen (supportText.test.ts
    // prüft `undefined` und erwartet "unbekannt"/"unknown").
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
      return t("support.toolPresent");
    case "not-recognized":
      return t("support.toolNotRecognized");
    case "unknown":
      return t("support.unknown");
  }
}

function tierLabel(tier: SupportFacts["protonDbTier"]): string {
  return tierText(tier);
}

function externalCompatdataLine(facts: SupportFacts): string {
  switch (facts.externalCompatdata) {
    case "detected":
      return t("support.externalCompatdataDetected");
    case "not-detected":
      return t("support.externalCompatdataNotDetected");
    case "unknown":
      return t("support.externalCompatdataUnknown");
  }
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
  const cleanup = facts.cleanup;
  if (
    !cleanup.scanInProgress &&
    !cleanup.prefixUnavailable &&
    !cleanup.shaderUnavailable &&
    !cleanup.trashUnavailable &&
    !(cleanup.incompleteDeletionsCount !== null && cleanup.incompleteDeletionsCount > 0) &&
    !cleanup.incompleteDeletionsUnreadable
  ) {
    return [t("support.cleanupNoFindings")];
  }
  const lines = [t("support.cleanupDisplayedState")];
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
    "",
    t("support.scanCoverage", { state: coverageLabel(facts.scanCoverage) }),
  ];
  if (facts.compatConfigStatus !== "available") {
    lines.push(t("support.config", { status: configStatusLabel(facts.compatConfigStatus) }));
  }
  if (facts.launchConfigStatus !== "available") {
    lines.push(t("support.launchConfig", { status: configStatusLabel(facts.launchConfigStatus) }));
  }
  if (facts.scanCoverageCounts !== null) {
    lines.push(
      t("support.scanCoverageCounts", {
        read: facts.scanCoverageCounts.librariesRead,
        total: facts.scanCoverageCounts.librariesTotal,
        manifests: facts.scanCoverageCounts.manifestsFailed,
        tools: facts.scanCoverageCounts.toolsFailed,
      }),
    );
  }
  lines.push(
    t("support.assignedToolWithSource", {
      tool: facts.compatToolAlias ?? t("support.unknown"),
      source: assignmentSourceLabel(facts.compatToolSource),
    }),
    t("support.toolAvailability", {
      status: toolAvailabilityLabel(facts.compatToolAvailability),
    }),
    facts.protonDbTier === "unknown"
      ? t("support.protonDbUnknown")
      : t("support.protonDb", { tier: tierLabel(facts.protonDbTier) }),
    footprintLine(facts),
    externalCompatdataLine(facts),
    ...cleanupLines(facts),
    "",
    t("support.anonymized"),
  );
  return lines.join("\n");
}
