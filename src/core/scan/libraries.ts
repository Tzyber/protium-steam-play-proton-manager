import { errText } from "../errtext.js";
import { parseLibraryFolders } from "../libraryfolders.js";
import { paths } from "../paths.js";
import type { Ports } from "../ports.js";
import type { SkippedLibrary } from "../types.js";

export async function readLibraryList(
  fs: Ports["fs"],
  system: Ports["system"],
  steamRoot: string,
): Promise<{
  libraries: string[];
  warnings: string[];
  skippedLibraries: SkippedLibrary[];
}> {
  const warnings: string[] = [];
  const skippedLibraries: SkippedLibrary[] = [];

  let libraries: string[] = [];
  try {
    const lfPath = paths.libraryFoldersVdf(steamRoot);
    if (await fs.exists(lfPath)) {
      libraries = parseLibraryFolders(await fs.readTextFile(lfPath));
    }
  } catch (e) {
    warnings.push(`libraryfolders.vdf nicht lesbar: ${errText(e)}`);
  }
  if (libraries.length === 0) libraries = [steamRoot];

  const uniqueLibraries: string[] = [];
  const seenIdentity = new Map<string, string>();
  for (const library of libraries) {
    const identity = await system.pathIdentity(library);
    if (!identity) {
      const exists = await fs.exists(library);
      const reason = exists ? "scope-failed" : "path-missing";
      warnings.push(
        exists
          ? `library-pfad nicht erreichbar (identity-check fehlgeschlagen), übersprungen: ${library}`
          : `library-pfad existiert nicht (tote config-leiche), übersprungen: ${library}`,
      );
      skippedLibraries.push({ path: library, reason });
      continue;
    }
    const key = `${identity.dev}:${identity.ino}`;
    const first = seenIdentity.get(key);
    if (first) {
      warnings.push(
        `library "${library}" ist dieselbe wie "${first}" (identischer datenträger), übersprungen`,
      );
      continue;
    }
    seenIdentity.set(key, library);
    uniqueLibraries.push(library);
  }

  return { libraries: uniqueLibraries, warnings, skippedLibraries };
}
