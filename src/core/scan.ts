import type { EnvironmentSnapshot, Ports } from "./ports.js";
import { scanLocal } from "./scan/local.js";
import { enrichProtondb } from "./scan/protondb.js";
import type { ScanResult } from "./types.js";

interface ScanOptions {
  environment: EnvironmentSnapshot;
  protonDbDelayMs?: number;
}

export async function scanLibrary(ports: Ports, opts: ScanOptions): Promise<ScanResult> {
  const { environment } = opts;
  if (
    environment.generation < 1 ||
    environment.steamRoot.length === 0 ||
    !environment.libraries.includes(environment.steamRoot)
  ) {
    throw new Error("environment snapshot is missing a current Steam root");
  }
  const local = await scanLocal(ports, environment);
  await enrichProtondb(ports, local.games, opts.protonDbDelayMs ?? 150);

  return {
    steamRoot: environment.steamRoot,
    ...local,
  };
}
