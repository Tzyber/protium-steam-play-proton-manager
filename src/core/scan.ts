import type { Ports } from "./ports.js";
import { scanLocal } from "./scan/local.js";
import { enrichProtondb } from "./scan/protondb.js";
import type { ScanResult } from "./types.js";

interface ScanOptions {
  steamRoot: string;
  protonDbDelayMs?: number;
  /** compat-dirs überschreiben, für tests. */
  extraCompatDirs?: readonly string[];
}

export async function scanLibrary(ports: Ports, opts: ScanOptions): Promise<ScanResult> {
  const { steamRoot } = opts;
  const local = await scanLocal(ports, steamRoot, opts.extraCompatDirs);
  await enrichProtondb(ports, local.games, opts.protonDbDelayMs ?? 150);

  return {
    steamRoot,
    ...local,
  };
}
