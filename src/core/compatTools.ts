// Lesende Compat-Tool-Regeln: Mapping aus config.vdf, Identität aus der
// tool-vdf und die eine usedBy-Regel. Bewusst getrennt vom Verzeichnis-Scan in
// `compat.ts`, hier steht nur Parsing und Zuordnung, dort Dateisystem und
// Größenmessung.

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
export function readToolVdf(
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

/** die eine usedBy-regel: appIds, die dem tool über das mapping zugeordnet und
 *  installiert sind. `mapping` kann der config.vdf-stand oder der
 *  in-memory-spielstand sein; beide quellen tragen dieselbe bedeutung. */
export function usedBy(
  toolName: string,
  mapping: Iterable<readonly [number, string]>,
  installedAppIds: ReadonlySet<number>,
): number[] {
  const found: number[] = [];
  for (const [appId, name] of mapping) {
    if (name === toolName && installedAppIds.has(appId)) found.push(appId);
  }
  return found;
}

/** dieselbe regel gegen den in-memory-spielstand: nach einem compat-tool-wechsel
 *  im drawer ist config.vdf auf disk schon aktuell, die scan-ergebnisse aber
 *  nicht neu gerechnet, sonst zeigt der proton-manager bis zum nächsten rescan
 *  stale spiele-zähler. */
export function recomputeToolUsedBy(
  tools: { internalName: string; usedBy: number[] }[],
  games: readonly { appId: number; compatTool: string }[],
): void {
  const mapping = games.map((game) => [game.appId, game.compatTool] as const);
  const installed = new Set(games.map((game) => game.appId));
  for (const tool of tools) {
    tool.usedBy = usedBy(tool.internalName, mapping, installed);
  }
}
