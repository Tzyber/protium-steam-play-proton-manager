import type { CompatToolMapping } from "./compatTools.js";
import { readToolVdf, usedBy } from "./compatTools.js";
import { errText } from "./errtext.js";
import { joinPath, paths } from "./paths.js";
import type { DirEntry, FileSystem, System } from "./ports.js";
import type { CompatTool, ReadFailedCounts, ScanWarning } from "./types.js";

interface CompatToolScanResult {
  tools: CompatTool[];
  warnings: ScanWarning[];
  counts: ReadFailedCounts;
}

export async function listCompatTools(
  fs: FileSystem,
  system: System,
  steamRoot: string,
  mapping: CompatToolMapping,
  installedAppIds: ReadonlySet<number>,
  systemCompatDirs: readonly string[] = [],
): Promise<CompatToolScanResult> {
  const warnings: ScanWarning[] = [];
  // ein fehlgeschlagener schritt erzeugt immer dieselbe form: zähler hoch und
  // eine warnung mit grund. neun aufrufstellen, ein platz für form und zähler.
  const fail = (
    reason: Extract<ScanWarning, { type: "compat-tool" }>["reason"],
    detail: string,
    dir: string,
    toolName?: string,
  ): void => {
    failedCount += 1;
    warnings.push({ type: "compat-tool", directory: dir, toolName, reason, detail });
  };

  const candidateDirs = [paths.compatToolsDir(steamRoot), ...systemCompatDirs];
  const userDir = paths.compatToolsDir(steamRoot);

  const tools: CompatTool[] = [];
  const seenDirs = new Set<string>(); // dedup via canonical path or (dev, ino)
  const seenInternal = new Set<string>(); // dedup tools über internen namen
  let readCount = 0;
  let failedCount = 0;

  for (const dir of candidateDirs) {
    const source: "user" | "system" = dir === userDir ? "user" : "system";
    let present: boolean;
    try {
      present = await fs.exists(dir);
    } catch (e) {
      fail("directory-unreadable", errText(e), dir);
      continue;
    }
    if (!present) continue;

    let id: Awaited<ReturnType<System["pathIdentity"]>>;
    try {
      id = await system.pathIdentity(dir);
      if (!id) throw new Error("pathIdentity not available");
    } catch (e) {
      fail("path-identity", errText(e), dir);
      continue;
    }
    const identityKeys = [`path:${id.realpath}`, `inode:${id.dev}:${id.ino}`];
    if (identityKeys.some((key) => seenDirs.has(key))) continue;
    for (const key of identityKeys) seenDirs.add(key); // symlink-duplikat

    let entries: DirEntry[];
    try {
      entries = await fs.readDir(dir);
    } catch (e) {
      fail("directory-unreadable", `compat directory "${dir}" not readable: ${errText(e)}`, dir);
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymlink) {
        // ein symlink in compatibilitytools.d kann nach ausserhalb zeigen und
        // wird deshalb nicht als Tool geführt und als Warnung gemeldet,
        // sonst verschwindet ein sichtbares verzeichnis ohne erklärung.
        fail("symlink", `"${entry.name}" in ${dir} is a symlink, skipped`, dir, entry.name);
        continue;
      }
      if (!entry.isDirectory) continue;
      const name = entry.name;
      let internalName = name;
      let displayName = name;
      const vdfPath = paths.compatToolVdfIn(dir, name);
      let hasVdf: boolean;
      try {
        hasVdf = await fs.exists(vdfPath);
      } catch (e) {
        fail("vdf-unreadable", errText(e), dir, name);
        continue;
      }
      if (hasVdf) {
        let text: string;
        try {
          text = await fs.readTextFile(vdfPath);
        } catch (e) {
          fail("vdf-unreadable", errText(e), dir, name);
          continue;
        }
        try {
          ({ internalName, displayName } = readToolVdf(text, name));
        } catch (e) {
          fail("vdf-invalid", errText(e), dir, name);
          continue;
        }
      }

      let sizeBytes: number | undefined;
      try {
        const size = await system.dirSize(joinPath(dir, name));
        if (size.status === "measured") {
          if (!Number.isSafeInteger(size.sizeBytes) || size.sizeBytes < 0) {
            throw new Error(`invalid size: ${size.sizeBytes}`);
          }
          sizeBytes = size.sizeBytes;
        } else {
          throw new Error(
            size.status === "failed"
              ? (size.detail ?? "size measurement failed")
              : "path disappeared during size measurement",
          );
        }
      } catch (e) {
        fail("size-unreadable", errText(e), dir, name);
        // tool bleibt im inventar: internalName/displayName sind bekannt, nur
        // die größe nicht. ein unvollständiges inventar darf später keinen
        // falschen tool-not-recognized erzeugen (protoncheck.ts).
      }

      readCount += 1;
      if (seenInternal.has(internalName)) continue; // aus höher-priorisierter quelle
      seenInternal.add(internalName);
      // nur der interne name: er steht im mapping und im library-filter
      // (uiStore.showLibraryForTool). ein zusätzlicher treffer über den
      // verzeichnisnamen würde spiele zählen, die die library danach nicht zeigt.
      // nur installierte echte spiele: keine stale einträge, kein appId 0,
      // keine non-steam-shortcuts.
      const usedByApps = usedBy(internalName, mapping, installedAppIds);
      tools.push({
        name,
        internalName,
        displayName,
        sizeBytes,
        usedBy: usedByApps,
        source,
      });
    }
  }
  return { tools, warnings, counts: { read: readCount, failed: failedCount } };
}
