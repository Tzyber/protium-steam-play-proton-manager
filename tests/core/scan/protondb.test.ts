import { describe, expect, it } from "vitest";
import { enrichProtondb } from "../../../src/core/scan/protondb.js";
import type { Game } from "../../../src/core/types.js";
import { buildFakeSteam, fakeSystem, memCache, nodeFs } from "../../support/fakeSteam";

const game = (appId: number, library = "/steam"): Game => ({
  appId,
  name: `game-${appId}`,
  library,
  sizeBytes: 0,
  compatTool: "default",
  protonDb: null,
  localHeader: null,
  headerImage: null,
});

describe("enrichProtondb", () => {
  it("mutiert Spiele seriell und setzt bei fehlendem Report unknown", async () => {
    const { root } = await buildFakeSteam();
    const games = [game(620, root), game(570, root)];
    const calls: number[] = [];
    const ports = {
      fs: nodeFs(),
      system: fakeSystem(),
      cache: memCache(),
      http: {
        async get(url: string) {
          const appId = Number(url.split("/").at(-1)?.replace(".json", ""));
          calls.push(appId);
          if (appId === 620) {
            return {
              status: 200,
              ok: true,
              text: JSON.stringify({ tier: "gold", confidence: "strong" }),
              headers: {},
            };
          }
          return { status: 404, ok: false, text: "", headers: {} };
        },
      },
    };

    await enrichProtondb(ports, games, 0);

    expect(calls).toEqual([620, 570]);
    expect(games.map((candidate) => candidate.protonDb)).toEqual([
      { tier: "gold", confidence: "strong" },
      { tier: "unknown", confidence: "unknown" },
    ]);
  });
});
