// Lokalen Cover-Pfad eines Spiels auflösen. Liegt bewusst neben
// `scan/games.ts`: dort läuft der Manifest-Scan, hier nur die Suche nach der
// heruntergeladenen Kopie im librarycache.

import { paths } from "../paths.js";
import type { Ports } from "../ports.js";

/** cover liegt unter librarycache/{appId}/{hash}/; der hash-unterordner ist
 *  unbekannt und muss durchsucht werden. Ein defekter cache zählt wie ein
 *  fehlender (INV-2: degradieren statt werfen). */
export async function resolveLocalHeader(
  fs: Ports["fs"],
  steamRoot: string,
  appId: number,
): Promise<string | null> {
  const dir = paths.libraryCacheAppDir(steamRoot, appId);
  try {
    if (!(await fs.exists(dir))) return null;
    for (const entry of await fs.readDir(dir)) {
      if (!entry.isDirectory) continue;
      const candidate = paths.libraryCacheHeader(dir, entry.name);
      if (await fs.exists(candidate)) return candidate;
    }
  } catch {
    // Defekte Cover-Dateien werden wie fehlende behandelt.
  }
  return null;
}
