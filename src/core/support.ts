import type { GameFootprint } from "./footprint.js";
import { hasExternalCompatdata } from "./footprint.js";
import { deriveProtonCheck, isCompatToolPresent } from "./protoncheck.js";
import { deriveScanCoverage } from "./scan/coverage.js";
import {
  type CompatConfigStatus,
  type CompatToolSource,
  type Game,
  isRecord,
  type LaunchConfigStatus,
  MAX_APP_ID,
  type ScanResult,
  type Tier,
} from "./types.js";

export type SupportToolAvailability = "available" | "not-recognized" | "unknown";
export type SupportExternalCompatdata = "detected" | "unknown";
export type SupportToolAlias = "<compat-tool-1>";

export interface SupportCleanupInput {
  scanning?: boolean;
  trashScanning?: boolean;
  prefixUnavailable?: boolean;
  shaderUnavailable?: boolean;
  trashUnavailable?: boolean;
  incompleteDeletionsCount?: number;
  incompleteDeletionsUnreadable?: boolean;
}

export interface SupportCleanupFacts {
  scanInProgress: boolean;
  prefixUnavailable: boolean;
  shaderUnavailable: boolean;
  trashUnavailable: boolean;
  incompleteDeletionsCount: number | null;
  incompleteDeletionsUnreadable: boolean;
}

export interface SupportFootprintFacts {
  status: "complete" | "partial" | "not-measured";
  sizeBytes?: number;
}

export interface SupportInput {
  game: Game;
  result: ScanResult;
  footprint?: Pick<GameFootprint, "summary"> | null;
  cleanup?: SupportCleanupInput;
}

export interface SupportFacts {
  appId: number | null;
  library: string | null;
  scanCoverage: "complete" | "incomplete" | "limited";
  compatConfigStatus: CompatConfigStatus | "unknown";
  launchConfigStatus: LaunchConfigStatus | "unknown";
  compatToolSource: CompatToolSource;
  compatToolAlias: SupportToolAlias | null;
  compatToolAvailability: SupportToolAvailability;
  protonDbTier: Tier;
  footprint: SupportFootprintFacts;
  externalCompatdata: SupportExternalCompatdata;
  cleanup: SupportCleanupFacts;
}

const TOOL_ALIAS: SupportToolAlias = "<compat-tool-1>";

function validAppId(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_APP_ID
    ? value
    : null;
}

function validNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function compatConfigStatus(value: unknown): CompatConfigStatus | "unknown" {
  if (value === "available" || value === "missing" || value === "unreadable") return value;
  return "unknown";
}

function launchConfigStatus(value: unknown): LaunchConfigStatus | "unknown" {
  if (
    value === "available" ||
    value === "missing" ||
    value === "unreadable" ||
    value === "ambiguous"
  ) {
    return value;
  }
  return "unknown";
}

function compatToolSource(value: unknown): CompatToolSource {
  if (value === "explicit" || value === "default" || value === "unavailable") return value;
  return "unavailable";
}

function tier(value: unknown): Tier {
  if (
    value === "platinum" ||
    value === "gold" ||
    value === "silver" ||
    value === "bronze" ||
    value === "borked" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function libraryAlias(game: Game, result: ScanResult): string | null {
  if (!Array.isArray(result.libraries) || typeof game.library !== "string") return null;
  const index = result.libraries.indexOf(game.library);
  return index < 0 ? null : `<steam-library-${index + 1}>`;
}

function isToolName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value !== "default" && value !== "unknown"
  );
}

function toolNotRecognized(result: ScanResult, appId: number): boolean {
  return deriveProtonCheck(result).some(
    (check) => check.appId === appId && check.reasons.includes("tool-not-recognized"),
  );
}

function projectCompatTool(
  game: Game,
  result: ScanResult,
  configStatus: CompatConfigStatus | "unknown",
): Pick<SupportFacts, "compatToolSource" | "compatToolAlias" | "compatToolAvailability"> {
  const source = compatToolSource(game.compatToolSource);
  if (configStatus !== "available") {
    return {
      compatToolSource: "unavailable",
      compatToolAlias: null,
      compatToolAvailability: "unknown",
    };
  }

  const assignedTool = source === "explicit" ? game.compatTool : result.defaultCompatTool;
  if (source === "unavailable") {
    return {
      compatToolSource: "unavailable",
      compatToolAlias: null,
      compatToolAvailability: "unknown",
    };
  }
  if (!isToolName(assignedTool)) {
    return {
      compatToolSource: source === "default" ? "unavailable" : source,
      compatToolAlias: null,
      compatToolAvailability: "unknown",
    };
  }

  if (isCompatToolPresent(result, assignedTool)) {
    return {
      compatToolSource: source,
      compatToolAlias: TOOL_ALIAS,
      compatToolAvailability: "available",
    };
  }
  return {
    compatToolSource: source,
    compatToolAlias: TOOL_ALIAS,
    compatToolAvailability:
      source === "explicit" &&
      validAppId(game.appId) !== null &&
      toolNotRecognized(result, game.appId)
        ? "not-recognized"
        : "unknown",
  };
}

function projectFootprint(
  footprint: Pick<GameFootprint, "summary"> | null | undefined,
): SupportFootprintFacts {
  const summary: unknown = footprint?.summary;
  if (!isRecord(summary)) return { status: "not-measured" };
  if (summary.status !== "complete" && summary.status !== "partial") {
    return { status: "not-measured" };
  }
  const sizeBytes = validNonNegativeInteger(summary.sizeBytes);
  return sizeBytes === null ? { status: "not-measured" } : { status: summary.status, sizeBytes };
}

function projectCleanup(input: SupportCleanupInput | undefined): SupportCleanupFacts {
  return {
    scanInProgress: input?.scanning === true || input?.trashScanning === true,
    prefixUnavailable: input?.prefixUnavailable === true,
    shaderUnavailable: input?.shaderUnavailable === true,
    trashUnavailable: input?.trashUnavailable === true,
    incompleteDeletionsCount: validNonNegativeInteger(input?.incompleteDeletionsCount),
    incompleteDeletionsUnreadable: input?.incompleteDeletionsUnreadable === true,
  };
}

export function projectSupportFacts(input: SupportInput): SupportFacts {
  const compatConfig = compatConfigStatus(input.result.compatConfigStatus);
  const launchConfig = launchConfigStatus(input.result.launchConfigStatus);
  const tool = projectCompatTool(input.game, input.result, compatConfig);
  const protonDbTier = tier(input.game.protonDb?.tier);
  const appId = validAppId(input.game.appId);

  return {
    appId,
    library: libraryAlias(input.game, input.result),
    scanCoverage: deriveScanCoverage(input.result).state,
    compatConfigStatus: compatConfig,
    launchConfigStatus: launchConfig,
    ...tool,
    protonDbTier,
    footprint: projectFootprint(input.footprint),
    externalCompatdata:
      launchConfig === "available" && hasExternalCompatdata(input.game.launchOptions)
        ? "detected"
        : "unknown",
    cleanup: projectCleanup(input.cleanup),
  };
}
