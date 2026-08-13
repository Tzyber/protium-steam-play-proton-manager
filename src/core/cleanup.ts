import { paths } from "./paths.js";
import type { DirEntry, FileSystem } from "./ports.js";
import { NUMERIC_RE, type OrphanEntry, type OrphanType, parseSafeAppId } from "./types.js";

const ORPHAN_TYPES: OrphanType[] = ["compatdata", "shadercache"];

export async function findOrphans(
  libraries: readonly string[],
  installedAppIds: ReadonlySet<number>,
  fs: FileSystem,
): Promise<OrphanEntry[]> {
  const orphans: OrphanEntry[] = [];

  for (const lib of libraries) {
    for (const type of ORPHAN_TYPES) {
      const dir = type === "compatdata" ? paths.compatdataDir(lib) : paths.shadercacheDir(lib);

      let entries: DirEntry[];
      try {
        entries = await fs.readDir(dir);
      } catch {
        continue; // INV-2: verzeichnis existiert nicht / nicht lesbar → skip
      }

      for (const entry of entries) {
        if (!entry.isDirectory || entry.isSymlink) continue;
        if (!NUMERIC_RE.test(entry.name)) continue;
        const appId = parseSafeAppId(entry.name);
        if (appId === null) continue;
        if (installedAppIds.has(appId)) continue;

        const orphanPath =
          type === "compatdata"
            ? paths.compatdataPath(lib, entry.name)
            : paths.shadercachePath(lib, entry.name);

        orphans.push({
          appId,
          type,
          path: orphanPath,
          library: lib,
        });
      }
    }
  }

  return orphans;
}
