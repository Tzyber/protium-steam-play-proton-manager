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
  // die snapshot-prüfung (generation, wurzel, libraries) liegt in `scanLocal`,
  // dem gemeinsamen einstieg aller scan-pfade.
  const local = await scanLocal(ports, environment);
  await enrichProtondb(ports, local.games, opts.protonDbDelayMs ?? 150);

  return {
    steamRoot: environment.steamRoot,
    ...local,
  };
}
