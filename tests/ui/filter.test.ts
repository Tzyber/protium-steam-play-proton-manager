import { describe, expect, it } from "vitest";
import type { Game, Tier } from "../../src/core/types";
import { filterAndSortGames, fuzzyMatch, type LibraryQuery } from "../../src/ui/filter";

function game(
  partial: Omit<Partial<Game>, "compatToolSource"> & { appId: number; name: string },
  compatToolSource: Game["compatToolSource"] = "default",
): Game {
  return {
    library: "/lib",
    sizeBytes: 0,
    compatTool: "default",
    compatToolSource,
    protonDb: { tier: "unknown", confidence: "unknown" },
    localHeader: null,
    headerImage: null,
    ...partial,
  };
}

const games: Game[] = [
  game({
    appId: 1,
    name: "Atomic Heart",
    sizeBytes: 100,
    compatTool: "proton-cachyos-slr",
    protonDb: { tier: "platinum", confidence: "strong" },
  }),
  game({
    appId: 2,
    name: "Stardew Valley",
    sizeBytes: 50,
    compatTool: "default",
    protonDb: { tier: "gold", confidence: "strong" },
  }),
  game({
    appId: 3,
    name: "The Forest",
    sizeBytes: 200,
    compatTool: "proton-cachyos-slr",
    protonDb: { tier: "gold", confidence: "strong" },
  }),
  game({
    appId: 4,
    name: "SOMA",
    sizeBytes: 10,
    compatTool: "proton_hotfix",
    protonDb: { tier: "unknown", confidence: "unknown" },
  }),
];

const base: LibraryQuery = {
  search: "",
  sortKey: "name",
  sortDir: "asc",
  tiers: new Set<Tier>(),
  compatTools: new Set<string>(),
  libraries: new Set<string>(),
};

const ids = (gs: Game[]) => gs.map((g) => g.appId);

describe("fuzzyMatch", () => {
  it("substring", () => expect(fuzzyMatch("Atomic Heart", "heart")).toBe(true));
  it("subsequence", () => expect(fuzzyMatch("Stardew Valley", "stdw")).toBe(true));
  it("leere query matcht alles", () => expect(fuzzyMatch("x", "")).toBe(true));
  it("kein match", () => expect(fuzzyMatch("SOMA", "zzz")).toBe(false));
});

describe("filterAndSortGames", () => {
  it("sortiert name aufsteigend", () => {
    expect(ids(filterAndSortGames(games, base))).toEqual([1, 4, 2, 3]);
  });
  it("sortiert größe absteigend", () => {
    expect(ids(filterAndSortGames(games, { ...base, sortKey: "size", sortDir: "desc" }))).toEqual([
      3, 1, 2, 4,
    ]);
  });
  it("sortiert unbekannte größen unabhängig von der richtung zuletzt", () => {
    const withUnknown = [
      ...games,
      game({ appId: 5, name: "Unknown Asc", sizeBytes: undefined }),
      game({ appId: 6, name: "Unknown Desc", sizeBytes: undefined }),
    ];

    expect(
      ids(filterAndSortGames(withUnknown, { ...base, sortKey: "size", sortDir: "asc" })),
    ).toEqual([4, 2, 1, 3, 5, 6]);
    expect(
      ids(filterAndSortGames(withUnknown, { ...base, sortKey: "size", sortDir: "desc" })),
    ).toEqual([3, 1, 2, 4, 6, 5]);
  });
  it("sortiert tier absteigend (platinum zuerst)", () => {
    const r = filterAndSortGames(games, { ...base, sortKey: "tier", sortDir: "desc" });
    expect(r[0]?.appId).toBe(1); // platinum
    expect(r.at(-1)?.appId).toBe(4); // unknown zuletzt
  });
  it("filtert nach tier", () => {
    expect(ids(filterAndSortGames(games, { ...base, tiers: new Set<Tier>(["gold"]) }))).toEqual([
      2, 3,
    ]);
  });
  it("filtert nach compat-tool", () => {
    expect(
      ids(filterAndSortGames(games, { ...base, compatTools: new Set(["proton-cachyos-slr"]) })),
    ).toEqual([1, 3]);
  });
  it("filtert nach der quelle der proton-zuordnung, undefined heißt alle", () => {
    const withSources = [
      game({ appId: 11, name: "Default Game" }, "default"),
      game({ appId: 12, name: "Unknown Game" }, "unavailable"),
      game({ appId: 13, name: "Explicit Game" }, "explicit"),
    ];
    expect(ids(filterAndSortGames(withSources, base))).toEqual([11, 13, 12]);
    expect(ids(filterAndSortGames(withSources, { ...base, compatSource: "default" }))).toEqual([
      11,
    ]);
    expect(ids(filterAndSortGames(withSources, { ...base, compatSource: "unavailable" }))).toEqual([
      12,
    ]);
    expect(ids(filterAndSortGames(withSources, { ...base, compatSource: "explicit" }))).toEqual([
      13,
    ]);
  });
  it("sortiert nach zuletzt gespielt, fehlende werte unabhängig von der richtung zuletzt", () => {
    const played = [
      game({ appId: 21, name: "Old", lastPlayed: 100 }),
      game({ appId: 22, name: "New", lastPlayed: 300 }),
      game({ appId: 23, name: "Never A", lastPlayed: undefined }),
      game({ appId: 24, name: "Middle", lastPlayed: 200 }),
      game({ appId: 25, name: "Never B", lastPlayed: undefined }),
    ];

    expect(
      ids(filterAndSortGames(played, { ...base, sortKey: "lastPlayed", sortDir: "desc" })),
    ).toEqual([22, 24, 21, 25, 23]);
    expect(
      ids(filterAndSortGames(played, { ...base, sortKey: "lastPlayed", sortDir: "asc" })),
    ).toEqual([21, 24, 22, 23, 25]);
  });
  it("kombiniert suche + filter", () => {
    const r = filterAndSortGames(games, { ...base, search: "the", tiers: new Set<Tier>(["gold"]) });
    expect(ids(r)).toEqual([3]);
  });
  it("kombiniert proton-check mit bestehenden filtern und sortierung", () => {
    const r = filterAndSortGames(games, {
      ...base,
      sortKey: "size",
      sortDir: "desc",
      protonCheckAppIds: new Set([1, 3]),
    });
    expect(ids(r)).toEqual([3, 1]);
  });
});
