import { type CompatToolSource, type Game, TIERS, type Tier } from "./types.js";

export type SortKey = "name" | "size" | "tier" | "lastPlayed";
export type SortDir = "asc" | "desc";

// export nur für den test (tests/core/filter.test.ts; K-13).
export interface LibraryQuery {
  search: string;
  sortKey: SortKey;
  sortDir: SortDir;
  tiers: ReadonlySet<Tier>; // leer = alle
  compatTools: ReadonlySet<string>; // leer = alle
  libraries: ReadonlySet<string>; // leer = alle
  compatSource?: CompatToolSource; // undefiniert = alle
  protonCheckAppIds?: ReadonlySet<number>; // undefiniert = alle
}

// best → schlecht; kanonische reihenfolge für filter-UI und sortierung.
// Abgeleitet aus `TIERS`: eine neue stufe ist automatisch dabei und kann
// nicht mehr nur in einer der beiden listen stehen (T-01, Audit 2026-11-17).
export const TIER_ORDER: readonly Tier[] = TIERS;

/** rang einer stufe für die tier-sortierung: position von hinten. über
 *  `indexOf` braucht es keine rank-map mit typ-cast. */
function tierRank(tier: Tier): number {
  return TIER_ORDER.length - 1 - TIER_ORDER.indexOf(tier);
}

/** case-insensitiv: substring ODER subsequence (leichtgewichtiges fuzzy).
 *  export nur für den test (tests/core/filter.test.ts; K-13). */
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
    if (q.compatSource && g.compatToolSource !== q.compatSource) return false;
    if (q.libraries.size && !q.libraries.has(g.library)) return false;
    if (q.protonCheckAppIds && !q.protonCheckAppIds.has(g.appId)) return false;
    return true;
  });

  const dir = q.sortDir === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    let cmp: number;
    if (q.sortKey === "size" || q.sortKey === "lastPlayed") {
      // fehlende werte immer ans ende, unabhängig von der richtung
      const aVal = q.sortKey === "size" ? a.sizeBytes : a.lastPlayed;
      const bVal = q.sortKey === "size" ? b.sizeBytes : b.lastPlayed;
      if (aVal === undefined && bVal !== undefined) return 1;
      if (aVal !== undefined && bVal === undefined) return -1;
      cmp = aVal === undefined || bVal === undefined ? 0 : aVal - bVal;
    } else if (q.sortKey === "tier") {
      cmp = tierRank(a.protonDb?.tier ?? "unknown") - tierRank(b.protonDb?.tier ?? "unknown");
    } else cmp = a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    // stabiler tie-break über name, damit reihenfolge nie „springt"
    if (cmp === 0) cmp = a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    return cmp * dir;
  });

  return filtered;
}
