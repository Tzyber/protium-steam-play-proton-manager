import { errText } from "./errtext.js";
import { joinPath, paths, SYSTEM_COMPAT_DIRS } from "./paths.js";
import type { DirEntry, FileSystem, System } from "./ports.js";
import type { CompatTool } from "./types.js";
import { asNode, asString, getPath, parseVdf } from "./vdf.js";

/** appId → compat-tool-name (interner name, wie in config.vdf). */
export type CompatToolMapping = Map<number, string>;

// Ein fehlender Teilbaum ergibt eine leere Map; ungültiges VDF wirft.
export function parseCompatToolMapping(configVdfText: string): CompatToolMapping {
  const root = parseVdf(configVdfText);
  const mappingNode = asNode(
    getPath(root, "InstallConfigStore", "Software", "Valve", "Steam", "CompatToolMapping"),
  );
  const out: CompatToolMapping = new Map();
  if (!mappingNode) return out;

  for (const key of Object.keys(mappingNode)) {
    const appId = Number(key);
    if (!Number.isInteger(appId)) continue;
    const name = asString(getPath(mappingNode, key, "name"));
    if (name && name.trim() !== "") out.set(appId, name);
  }
  return out;
}

// interner name (key) + display_name aus der tool-vdf.
function readToolVdf(
  text: string,
  fallbackName: string,
): { internalName: string; displayName: string } {
  let internalName = fallbackName;
  let displayName = fallbackName;
  const compatTools = asNode(getPath(parseVdf(text), "compatibilitytools", "compat_tools"));
  if (compatTools) {
    const internal = Object.keys(compatTools)[0];
    if (internal) {
      internalName = internal;
      const dn = asString(getPath(compatTools, internal, "display_name"));
      if (dn) displayName = dn;
    }
  }
  return { internalName, displayName };
}

// tools aus steam-root + systemweiten dirs (/usr/share/steam/…, z. B. proton-cachyos).
// dedup dirs via realpath gegen symlinks, dedup tools via internem namen (erste quelle gewinnt).
// usedBy matcht den INTERNEN namen (so steht er im mapping), nicht den verzeichnisnamen.

/** gleiche usedBy-regel wie in listCompatTools, aber gegen den in-memory-spielstand:
 *  nach einem compat-tool-wechsel im drawer ist config.vdf auf disk schon aktuell,
 *  die scan-ergebnisse aber nicht neu gerechnet, sonst zeigt der proton-manager
 *  bis zum nächsten rescan stale spiele-zähler. */
export function recomputeToolUsedBy(
  tools: { name: string; internalName: string; usedBy: number[] }[],
  games: readonly { appId: number; compatTool: string }[],
): void {
  for (const tool of tools) {
    tool.usedBy = games
      .filter((g) => g.compatTool === tool.internalName || g.compatTool === tool.name)
      .map((g) => g.appId);
  }
}
export async function listCompatTools(
  fs: FileSystem,
  system: System,
  steamRoot: string,
  mapping: CompatToolMapping,
  warnings: string[],
  installedAppIds: ReadonlySet<number>,
  extraDirs: readonly string[] = SYSTEM_COMPAT_DIRS,
): Promise<CompatTool[]> {
  // nur installierte echte spiele: keine stale einträge, kein appId 0, keine non-steam-shortcuts.
  const usedByOf = (id: string): number[] =>
    [...mapping.entries()]
      .filter(([appId, name]) => name === id && installedAppIds.has(appId))
      .map(([appId]) => appId);

  const candidateDirs = [paths.compatToolsDir(steamRoot), ...extraDirs];
  const userDir = paths.compatToolsDir(steamRoot);

  const tools: CompatTool[] = [];
  const seenDirs = new Set<string>(); // dedup via realpath
  const seenInternal = new Set<string>(); // dedup tools über internen namen

  for (const dir of candidateDirs) {
    const source: "user" | "system" = dir === userDir ? "user" : "system";
    if (source === "system") {
      try {
        await system.allowLibraryScope(dir); // Der Steam-Root ist bereits im Scope.
      } catch {
        continue;
      }
    }

    const id = await system.pathIdentity(dir);
    const realKey = id ? id.realpath : dir;
    if (seenDirs.has(realKey)) continue; // symlink-duplikat
    seenDirs.add(realKey);

    let entries: DirEntry[];
    try {
      if (!(await fs.exists(dir))) continue;
      entries = await fs.readDir(dir);
    } catch (e) {
      warnings.push(`compat-verzeichnis "${dir}" nicht lesbar: ${errText(e)}`);
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymlink) {
        // ein symlink in compatibilitytools.d kann nach ausserhalb zeigen und
        // wird deshalb nicht als Tool geführt und als Warnung gemeldet,
        // sonst verschwindet ein sichtbares verzeichnis ohne erklärung.
        warnings.push(`"${entry.name}" in ${dir} ist ein symlink → übersprungen`);
        continue;
      }
      if (!entry.isDirectory) continue;
      const name = entry.name;
      try {
        let internalName = name;
        let displayName = name;
        const vdfPath = paths.compatToolVdfIn(dir, name);
        if (await fs.exists(vdfPath)) {
          ({ internalName, displayName } = readToolVdf(await fs.readTextFile(vdfPath), name));
        }
        if (seenInternal.has(internalName)) continue; // aus höher-priorisierter quelle
        seenInternal.add(internalName);

        const sizeBytes = await system.dirSize(joinPath(dir, name));
        const usedBy = usedByOf(internalName);
        if (internalName !== name) {
          for (const appId of usedByOf(name)) if (!usedBy.includes(appId)) usedBy.push(appId);
        }
        tools.push({ name, internalName, displayName, sizeBytes, usedBy, source });
      } catch (e) {
        warnings.push(`compat-tool "${name}" übersprungen: ${errText(e)}`);
      }
    }
  }
  return tools;
}
