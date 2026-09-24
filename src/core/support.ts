import type { GameFootprint } from "./footprint.js";
import { hasExternalCompatdata } from "./footprint.js";
import { deriveProtonCheck, isCompatToolPresent } from "./protoncheck.js";
import { deriveScanCoverage } from "./scan/coverage.js";
import {
  isToolName,
  libraryAlias,
  projectToolName,
  validAppId,
  validNonNegativeInteger,
} from "./supportRedaction.js";
import {
  asCompatConfigStatus,
  asCompatToolSource,
  asLaunchConfigStatus,
  asTier,
  type CompatConfigStatus,
  type CompatToolSource,
  type Game,
  isRecord,
  type LaunchConfigStatus,
  type ScanCoverage,
  type ScanResult,
  type Tier,
} from "./types.js";

type SupportToolAvailability = "available" | "not-recognized" | "unknown";
type SupportExternalCompatdata = "detected" | "not-detected" | "unknown";

interface SupportCleanupInput {
  scanning?: boolean;
  trashScanning?: boolean;
  prefixUnavailable?: boolean;
  shaderUnavailable?: boolean;
  trashUnavailable?: boolean;
  incompleteDeletionsCount?: number;
  incompleteDeletionsUnreadable?: boolean;
}

interface SupportCleanupFacts {
  scanInProgress: boolean;
  prefixUnavailable: boolean;
  shaderUnavailable: boolean;
  trashUnavailable: boolean;
  incompleteDeletionsCount: number | null;
  incompleteDeletionsUnreadable: boolean;
}

interface SupportFootprintFacts {
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
  scanCoverageCounts: {
    librariesRead: number;
    librariesTotal: number;
    manifestsFailed: number;
    toolsFailed: number;
  } | null;
  compatConfigStatus: CompatConfigStatus | "unknown";
  launchConfigStatus: LaunchConfigStatus | "unknown";
  compatToolSource: CompatToolSource;
  compatToolAlias: string | null;
  compatToolAvailability: SupportToolAvailability;
  protonDbTier: Tier;
  footprint: SupportFootprintFacts;
  externalCompatdata: SupportExternalCompatdata;
  cleanup: SupportCleanupFacts;
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
  const source = asCompatToolSource(game.compatToolSource);
  if (configStatus !== "available") {
    return {
      compatToolSource: "unavailable",
      compatToolAlias: null,
      compatToolAvailability: "unknown",
    };
  }

  if (source === "unavailable") {
    return {
      compatToolSource: "unavailable",
      compatToolAlias: null,
      compatToolAvailability: "unknown",
    };
  }
  const assignedTool = source === "explicit" ? game.compatTool : result.defaultCompatTool;
  if (!isToolName(assignedTool)) {
    return {
      compatToolSource: source === "default" ? "unavailable" : source,
      compatToolAlias: null,
      compatToolAvailability: "unknown",
    };
  }

  const compatToolAlias = projectToolName(assignedTool);
  if (isCompatToolPresent(result, assignedTool)) {
    return {
      compatToolSource: source,
      compatToolAlias,
      compatToolAvailability: "available",
    };
  }
  return {
    compatToolSource: source,
    compatToolAlias,
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

function projectScanCoverageCounts(coverage: ScanCoverage): SupportFacts["scanCoverageCounts"] {
  const librariesRead = validNonNegativeInteger(coverage.libraries.read);
  const librariesTotal = validNonNegativeInteger(coverage.libraries.total);
  const manifestsFailed = validNonNegativeInteger(coverage.manifests.failed);
  const toolsFailed = validNonNegativeInteger(coverage.tools.failed);
  if (
    librariesRead === null ||
    librariesTotal === null ||
    manifestsFailed === null ||
    toolsFailed === null
  ) {
    return null;
  }
  return { librariesRead, librariesTotal, manifestsFailed, toolsFailed };
}

export function projectSupportFacts(input: SupportInput): SupportFacts {
  const compatConfig = asCompatConfigStatus(input.result.compatConfigStatus);
  const launchConfig = asLaunchConfigStatus(input.result.launchConfigStatus);
  const tool = projectCompatTool(input.game, input.result, compatConfig);
  const protonDbTier = asTier(input.game.protonDb?.tier);
  const appId = validAppId(input.game.appId);
  const coverage = deriveScanCoverage(input.result);

  return {
    appId,
    library: libraryAlias(input.game, input.result),
    scanCoverage: coverage.state,
    scanCoverageCounts: coverage.state === "complete" ? null : projectScanCoverageCounts(coverage),
    compatConfigStatus: compatConfig,
    launchConfigStatus: launchConfig,
    ...tool,
    protonDbTier,
    footprint: projectFootprint(input.footprint),
    externalCompatdata:
      launchConfig !== "available"
        ? "unknown"
        : hasExternalCompatdata(input.game.launchOptions)
          ? "detected"
          : "not-detected",
    cleanup: projectCleanup(input.cleanup),
  };
}
