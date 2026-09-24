import type { CompatToolMapping } from "./compatTools.js";
import { readToolVdf, usedBy } from "./compatTools.js";
import { errText } from "./errtext.js";
import { joinPath, paths } from "./paths.js";
import type { DirEntry, FileSystem, PathIdentity, System } from "./ports.js";
import type { CompatTool, ReadFailedCounts, ScanWarning } from "./types.js";

interface CompatToolScanResult {
  tools: CompatTool[];
  warnings: ScanWarning[];
  counts: ReadFailedCounts;
}

/** ein fehlgeschlagener schritt erzeugt immer dieselbe form: zähler hoch und
 *  eine warnung mit grund. neun aufrufstellen, ein platz für form und zähler. */
function failCompatTool(
  warnings: ScanWarning[],
  counts: ReadFailedCounts,
  reason: Extract<ScanWarning, { type: "compat-tool" }>["reason"],
  detail: string,
  dir: string,
  toolName?: string,
): void {
  counts.failed += 1;
  warnings.push({ type: "compat-tool", directory: dir, toolName, reason, detail });
}

/** wertet ein compat-tool-verzeichnis aus: existenz, kanonische identität gegen
 *  ein bereits gesehenes (symlink-)verzeichnis und die einträge selbst. liefert
 *  `null`, wenn der ordner fehlt, unlesbar ist oder ein duplikat ist. */
async function readCompatDirEntries(
  fs: FileSystem,
  system: System,
  dir: string,
  seenDirs: Set<string>,
  warnings: ScanWarning[],
  counts: ReadFailedCounts,
): Promise<DirEntry[] | null> {
  let present: boolean;
  try {
    present = await fs.exists(dir);
  } catch (e) {
    failCompatTool(warnings, counts, "directory-unreadable", errText(e), dir);
    return null;
  }
  if (!present) return null;

  // `pathIdentity` meldet einen erwarteten `null`-zustand (ports.ts:82): direkt
  // als warnung behandeln statt über eine selbst gefangene exception (K-10).
  let identity: PathIdentity;
  try {
    const resolved = await system.pathIdentity(dir);
    if (resolved === null) {
      failCompatTool(warnings, counts, "path-identity", "path identity unavailable", dir);
      return null;
    }
    identity = resolved;
  } catch (e) {
    failCompatTool(warnings, counts, "path-identity", errText(e), dir);
    return null;
  }
  const identityKeys = [`path:${identity.realpath}`, `inode:${identity.dev}:${identity.ino}`];
  if (identityKeys.some((key) => seenDirs.has(key))) return null;
  for (const key of identityKeys) seenDirs.add(key); // symlink-duplikat

  try {
    return await fs.readDir(dir);
  } catch (e) {
    failCompatTool(
      warnings,
      counts,
      "directory-unreadable",
      `compat directory "${dir}" not readable: ${errText(e)}`,
      dir,
    );
    return null;
  }
}

/** wertet einen verzeichnis-eintrag als tool aus: vdf-name, größe. liefert
 *  `null` bei symlink, fehlendem verzeichnisflag oder vdf-fehler. eine
 *  fehlgeschlagene größenmessung bleibt im inventar (größe unbekannt). */
async function readCompatToolInfo(
  fs: FileSystem,
  system: System,
  dir: string,
  entry: DirEntry,
  warnings: ScanWarning[],
  counts: ReadFailedCounts,
): Promise<{ name: string; internalName: string; displayName: string; sizeBytes?: number } | null> {
  if (entry.isSymlink) {
    // ein symlink in compatibilitytools.d kann nach ausserhalb zeigen und
    // wird deshalb nicht als Tool geführt und als Warnung gemeldet,
    // sonst verschwindet ein sichtbares verzeichnis ohne erklärung.
    failCompatTool(
      warnings,
      counts,
      "symlink",
      `"${entry.name}" in ${dir} is a symlink, skipped`,
      dir,
      entry.name,
    );
    return null;
  }
  if (!entry.isDirectory) return null;
  const name = entry.name;
  let internalName = name;
  let displayName = name;
  const vdfPath = paths.compatToolVdfIn(dir, name);
  let hasVdf: boolean;
  try {
    hasVdf = await fs.exists(vdfPath);
  } catch (e) {
    failCompatTool(warnings, counts, "vdf-unreadable", errText(e), dir, name);
    return null;
  }
  if (hasVdf) {
    let text: string;
    try {
      text = await fs.readTextFile(vdfPath);
    } catch (e) {
      failCompatTool(warnings, counts, "vdf-unreadable", errText(e), dir, name);
      return null;
    }
    try {
      ({ internalName, displayName } = readToolVdf(text, name));
    } catch (e) {
      failCompatTool(warnings, counts, "vdf-invalid", errText(e), dir, name);
      return null;
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
    failCompatTool(warnings, counts, "size-unreadable", errText(e), dir, name);
    // tool bleibt im inventar: internalName/displayName sind bekannt, nur
    // die größe nicht. ein unvollständiges inventar darf später keinen
    // falschen tool-not-recognized erzeugen (protoncheck.ts).
  }

  return { name, internalName, displayName, sizeBytes };
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
  const counts: ReadFailedCounts = { read: 0, failed: 0 };
  const candidateDirs = [paths.compatToolsDir(steamRoot), ...systemCompatDirs];
  const userDir = paths.compatToolsDir(steamRoot);

  const tools: CompatTool[] = [];
  const seenDirs = new Set<string>(); // dedup via canonical path or (dev, ino)
  const seenInternal = new Set<string>(); // dedup tools über internen namen

  for (const dir of candidateDirs) {
    const source: "user" | "system" = dir === userDir ? "user" : "system";
    const entries = await readCompatDirEntries(fs, system, dir, seenDirs, warnings, counts);
    if (entries === null) continue;

    for (const entry of entries) {
      const info = await readCompatToolInfo(fs, system, dir, entry, warnings, counts);
      if (info === null) continue;

      counts.read += 1;
      if (seenInternal.has(info.internalName)) continue; // aus höher-priorisierter quelle
      seenInternal.add(info.internalName);
      // nur der interne name: er steht im mapping und im library-filter
      // (uiStore.showLibraryForTool). ein zusätzlicher treffer über den
      // verzeichnisnamen würde spiele zählen, die die library danach nicht zeigt.
      // nur installierte echte spiele: keine stale einträge, kein appId 0,
      // keine non-steam-shortcuts.
      const usedByApps = usedBy(info.internalName, mapping, installedAppIds);
      tools.push({
        name: info.name,
        internalName: info.internalName,
        displayName: info.displayName,
        sizeBytes: info.sizeBytes,
        usedBy: usedByApps,
        source,
      });
    }
  }
  return { tools, warnings, counts };
}
