import type { Game, Tier } from "../core/types";

export type SortKey = "name" | "size" | "tier";
export type SortDir = "asc" | "desc";

export interface LibraryQuery {
  search: string;
  sortKey: SortKey;
  sortDir: SortDir;
  tiers: ReadonlySet<Tier>; // leer = alle
  compatTools: ReadonlySet<string>; // leer = alle
  libraries: ReadonlySet<string>; // leer = alle
}

// best → schlecht; kanonische reihenfolge für filter-UI und sortierung
export const TIER_ORDER: Tier[] = ["platinum", "gold", "silver", "bronze", "borked", "unknown"];

export const TIER_RANK = Object.fromEntries(
  TIER_ORDER.map((t, i) => [t, TIER_ORDER.length - 1 - i]),
) as Record<Tier, number>;

/** case-insensitiv: substring ODER subsequence (leichtgewichtiges fuzzy). */
export function fuzzyMatch(name: string, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const n = name.toLowerCase();
  if (n.includes(q)) return true;
  let i = 0;
  for (const ch of n) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

export function filterAndSortGames(games: readonly Game[], q: LibraryQuery): Game[] {
  const filtered = games.filter((g) => {
    if (!fuzzyMatch(g.name, q.search)) return false;
    if (q.tiers.size && !q.tiers.has(g.protonDb?.tier ?? "unknown")) return false;
    if (q.compatTools.size && !q.compatTools.has(g.compatTool)) return false;
    if (q.libraries.size && !q.libraries.has(g.library)) return false;
    return true;
  });

  const dir = q.sortDir === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    let cmp: number;
    if (q.sortKey === "size") cmp = a.sizeBytes - b.sizeBytes;
    else if (q.sortKey === "tier")
      cmp = TIER_RANK[a.protonDb?.tier ?? "unknown"] - TIER_RANK[b.protonDb?.tier ?? "unknown"];
    else cmp = a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    // stabiler tie-break über name, damit reihenfolge nie „springt"
    if (cmp === 0) cmp = a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    return cmp * dir;
  });

  return filtered;
}
