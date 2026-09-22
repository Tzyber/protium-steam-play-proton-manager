// Texte der Scan-Coverage: übersetzt die Warnungen und Statuswerte eines
// Scans in die Zeilen, die das Coverage-Panel zeigt. Reine Abbildung ohne
// Zustand, damit sie ohne gemountete View prüfbar bleibt (vorher lag der
// vierfach verschachtelte Switch in `LibraryView.vue`).

import type { ScanWarning, SkipReason } from "../core/types.js";
import { formatDetail } from "./formatError.js";
import { type Key, t } from "./i18n/index.js";

type LibraryWarning = Extract<ScanWarning, { type: "library" }>;
type ManifestWarning = Extract<ScanWarning, { type: "manifest" }>;
type ToolWarning = Extract<ScanWarning, { type: "compat-tool" }>;

const LIBRARY_REASON: Record<SkipReason, Key> = {
  "path-missing": "library.coverageReasonPathMissing",
  "scope-failed": "library.coverageReasonScopeFailed",
  "read-failed": "library.coverageReasonReadFailed",
  unverified: "library.coverageReasonUnverified",
};

const CONFIG_REASON: Record<"missing" | "unreadable", Key> = {
  missing: "library.coverageReasonMissing",
  unreadable: "library.coverageReasonUnreadable",
};

const LAUNCH_REASON: Record<"missing" | "unreadable" | "selection-ambiguous", Key> = {
  missing: "library.coverageReasonMissing",
  unreadable: "library.coverageReasonUnreadable",
  "selection-ambiguous": "library.coverageReasonSelectionAmbiguous",
};

const MANIFEST_REASON: Record<ManifestWarning["reason"], Key> = {
  "invalid-filename": "library.coverageReasonInvalidFilename",
  unreadable: "library.coverageReasonUnreadable",
  "invalid-content": "library.coverageReasonInvalidContent",
  "appid-mismatch": "library.coverageReasonAppIdMismatch",
  duplicate: "library.coverageReasonDuplicate",
  "name-heuristic": "library.coverageReasonNameHeuristic",
};

const TOOL_REASON: Record<ToolWarning["reason"], Key> = {
  "path-identity": "library.coverageReasonPathIdentity",
  "directory-unreadable": "library.coverageReasonDirectoryUnreadable",
  symlink: "library.coverageReasonSymlink",
  "vdf-unreadable": "library.coverageReasonVdfUnreadable",
  "vdf-invalid": "library.coverageReasonVdfInvalid",
  "size-unreadable": "library.coverageReasonSizeUnreadable",
};

export function formatLibraryReason(reason: SkipReason): string {
  return t(LIBRARY_REASON[reason]);
}

export function formatConfigStatus(
  status: "available" | "missing" | "unreadable" | "ambiguous",
): string {
  switch (status) {
    case "available":
      return t("library.coverageStatusAvailable");
    case "missing":
      return t("library.coverageStatusMissing");
    case "unreadable":
      return t("library.coverageStatusUnreadable");
    case "ambiguous":
      return t("library.coverageStatusAmbiguous");
  }
}

/** Hängt eine geprüfte Detailklammer an; ein unbekannter Rohtext entfällt. */
function withDetail(base: string, ...parts: (string | undefined)[]): string {
  const shown = parts.filter((part): part is string => part !== undefined && part !== "");
  return shown.length === 0 ? base : `${base} · ${shown.join(" · ")}`;
}

function formatLibraryWarning(warning: LibraryWarning): string {
  return withDetail(
    t("library.coverageWarningLibrary", {
      path: warning.path,
      reason: t(LIBRARY_REASON[warning.reason]),
    }),
    formatDetail(warning.detail),
  );
}

function formatConfigWarning(
  warning: Extract<ScanWarning, { type: "compat-config" | "launch-config" }>,
): string {
  if (warning.type === "compat-config") {
    return withDetail(
      t("library.coverageWarningConfig", {
        source: t("library.coverageCompatConfig"),
        reason: t(CONFIG_REASON[warning.reason]),
      }),
      formatDetail(warning.detail),
    );
  }
  const account = warning.steamUserId
    ? t("library.coverageLaunchAccount", { id: warning.steamUserId })
    : undefined;
  return withDetail(
    t("library.coverageWarningConfig", {
      source: t("library.coverageLaunchConfig"),
      reason: t(LAUNCH_REASON[warning.reason]),
    }),
    account,
    formatDetail(warning.detail),
  );
}

function formatManifestWarning(warning: ManifestWarning): string {
  return withDetail(
    t("library.coverageWarningManifest", {
      name: warning.manifestName,
      reason: t(MANIFEST_REASON[warning.reason]),
    }),
    formatDetail(warning.detail),
  );
}

function formatToolWarning(warning: ToolWarning): string {
  return withDetail(
    t("library.coverageWarningTool", {
      name: warning.toolName ?? warning.directory,
      directory: warning.directory,
      reason: t(TOOL_REASON[warning.reason]),
    }),
    formatDetail(warning.detail),
  );
}

export function formatWarning(warning: ScanWarning): string {
  switch (warning.type) {
    case "library":
      return formatLibraryWarning(warning);
    case "compat-config":
    case "launch-config":
      return formatConfigWarning(warning);
    case "manifest":
      return formatManifestWarning(warning);
    case "compat-tool":
      return formatToolWarning(warning);
  }
}
