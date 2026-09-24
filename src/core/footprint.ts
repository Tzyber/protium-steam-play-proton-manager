import { paths } from "./paths.js";
import type { System } from "./ports.js";
import { type Game, isRecord, type LaunchConfigStatus } from "./types.js";

type FootprintPartStatus = "measured" | "missing" | "failed" | "not-requested";

export interface FootprintPart {
  status: FootprintPartStatus;
  sizeBytes?: number;
}

type FootprintSummaryStatus = "complete" | "partial" | "not-measured";

interface FootprintSummary {
  status: FootprintSummaryStatus;
  sizeBytes?: number;
}

export interface GameFootprint {
  gameInstall: FootprintPart;
  compatdata: FootprintPart;
  shadercache: FootprintPart;
  summary: FootprintSummary;
  externalCompatdata: boolean;
  compatdataNotChecked: boolean;
}

type FootprintGame = Pick<Game, "appId" | "library" | "installdir" | "launchOptions">;

interface RequestedTarget {
  part: "gameInstall" | "compatdata" | "shadercache";
  path: string;
}

// Jedes Vorkommen zählt: Hinweis und Öffnen-Sperre schlagen lieber zu oft als zu selten an.
export function hasExternalCompatdata(launchOptions: string | undefined): boolean {
  return typeof launchOptions === "string" && launchOptions.includes("STEAM_COMPAT_DATA_PATH");
}

function failedPart(): FootprintPart {
  return { status: "failed" };
}

function notRequestedPart(): FootprintPart {
  return { status: "not-requested" };
}

function parseWirePart(value: unknown): FootprintPart {
  if (!isRecord(value)) return failedPart();
  if (value.status === "missing") return { status: "missing", sizeBytes: 0 };
  if (
    value.status !== "measured" ||
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0
  ) {
    return failedPart();
  }
  return { status: "measured", sizeBytes: value.sizeBytes };
}

function summarize(parts: readonly FootprintPart[]): FootprintSummary {
  const knownParts = parts.filter(
    (part): part is FootprintPart & { status: "measured" | "missing"; sizeBytes: number } =>
      (part.status === "measured" || part.status === "missing") &&
      typeof part.sizeBytes === "number",
  );
  if (knownParts.length === 0) return { status: "not-measured" };

  let sizeBytes = 0;
  for (const part of knownParts) {
    if (sizeBytes > Number.MAX_SAFE_INTEGER - part.sizeBytes) {
      return { status: "not-measured" };
    }
    sizeBytes += part.sizeBytes;
  }

  const complete = knownParts.length === parts.length;
  return { status: complete ? "complete" : "partial", sizeBytes };
}

function resultFromParts(
  gameInstall: FootprintPart,
  compatdata: FootprintPart,
  shadercache: FootprintPart,
  externalCompatdata: boolean,
  compatdataNotChecked: boolean,
): GameFootprint {
  return {
    gameInstall,
    compatdata,
    shadercache,
    summary: summarize([gameInstall, compatdata, shadercache]),
    externalCompatdata,
    compatdataNotChecked,
  };
}

export async function measureGameFootprint(
  system: Pick<System, "batchDirSizes">,
  game: FootprintGame,
  launchConfigStatus: LaunchConfigStatus,
): Promise<GameFootprint> {
  const targets: RequestedTarget[] = [];
  let gameInstall: FootprintPart = notRequestedPart();

  if (typeof game.installdir === "string") {
    try {
      targets.push({
        part: "gameInstall",
        path: paths.gameInstallPath(game.library, game.installdir),
      });
    } catch {
      // Unsichere Manifestdaten bleiben unangefordert und werden nie an den Port gegeben.
    }
  }

  const externalCompatdata =
    launchConfigStatus === "available" && hasExternalCompatdata(game.launchOptions);
  const compatdataNotChecked = launchConfigStatus !== "available";
  if (!externalCompatdata && !compatdataNotChecked) {
    targets.push({
      part: "compatdata",
      path: paths.compatdataPath(game.library, game.appId),
    });
  }
  targets.push({
    part: "shadercache",
    path: paths.shadercachePath(game.library, game.appId),
  });

  const requestedPaths = targets.map((target) => target.path);
  let response: unknown;
  try {
    response = await system.batchDirSizes(requestedPaths);
  } catch {
    if (targets.some((target) => target.part === "gameInstall")) gameInstall = failedPart();
    const compatdata = targets.some((target) => target.part === "compatdata")
      ? failedPart()
      : notRequestedPart();
    const shadercache = targets.some((target) => target.part === "shadercache")
      ? failedPart()
      : notRequestedPart();
    return resultFromParts(
      gameInstall,
      compatdata,
      shadercache,
      externalCompatdata,
      compatdataNotChecked,
    );
  }

  const responseMap = isRecord(response) ? response : undefined;
  let compatdata: FootprintPart = notRequestedPart();
  let shadercache: FootprintPart = notRequestedPart();
  for (const target of targets) {
    const wireValue =
      responseMap !== undefined && Object.hasOwn(responseMap, target.path)
        ? responseMap[target.path]
        : undefined;
    const parsed = parseWirePart(wireValue);
    if (target.part === "gameInstall") gameInstall = parsed;
    if (target.part === "compatdata") compatdata = parsed;
    if (target.part === "shadercache") shadercache = parsed;
  }

  return resultFromParts(
    gameInstall,
    compatdata,
    shadercache,
    externalCompatdata,
    compatdataNotChecked,
  );
}
