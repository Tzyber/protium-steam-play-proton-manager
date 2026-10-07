import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichProtondb } from "../../../src/core/scan/protondb.js";
import type { Game } from "../../../src/core/types.js";
import { game as fixtureGame } from "../../support/factories";
import { buildFakeSteam, fakeSystem, memCache, nodeFs } from "../../support/fakeSteam";

/** kurzform für die spiele dieses tests; die feldliste kommt aus der geteilten
 *  fabrik, damit neue pflichtfelder nicht hier nachgezogen werden. */
const game = (appId: number, library: string): Game => fixtureGame({ appId, library });

describe("enrichProtondb", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("schläft bei einem reinen Cache-Treffer nicht", async () => {
    const { root } = await buildFakeSteam();
    const games = [game(620, root), game(570, root), game(730, root)];
    const calls: number[] = [];
    const settled: number[] = [];
    const sleep = vi.fn(async (_ms: number) => {});
    const cache = memCache();
    for (const appId of [620, 570, 730]) {
      await cache.set(
        `protondb:${appId}`,
        JSON.stringify({ tier: "gold", confidence: "strong", fetchedAt: Date.now() }),
      );
    }
    const ports = {
      fs: nodeFs(),
      system: fakeSystem(),
      cache,
      http: {
        async get(url: string) {
          calls.push(Number(url.split("/").at(-1)?.replace(".json", "")));
          return { status: 404, ok: false, text: "", headers: {} };
        },
      },
    };

    await enrichProtondb(ports, games, 150, {
      sleep,
      onSettled: (candidate) => settled.push(candidate.appId),
    });

    expect(calls).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(settled).toEqual([620, 570, 730]);
    expect(games.map((candidate) => candidate.protonDb)).toEqual([
      { tier: "gold", confidence: "strong" },
      { tier: "gold", confidence: "strong" },
      { tier: "gold", confidence: "strong" },
    ]);
  });

  it("schläft nach einem echten HTTP-Abruf weiter", async () => {
    const { root } = await buildFakeSteam();
    const games = [game(620, root), game(570, root), game(730, root)];
    const calls: number[] = [];
    const sleep = vi.fn(async (_ms: number) => {});
    const ports = {
      fs: nodeFs(),
      system: fakeSystem(),
      cache: memCache(),
      http: {
        async get(url: string) {
          const appId = Number(url.split("/").at(-1)?.replace(".json", ""));
          calls.push(appId);
          if (appId === 570) {
            return { status: 404, ok: false, text: "", headers: {} };
          }
          return {
            status: 200,
            ok: true,
            text: JSON.stringify({ tier: "silver", confidence: "strong" }),
            headers: {},
          };
        },
      },
    };

    await enrichProtondb(ports, games, 150, { sleep });

    expect(calls).toEqual([620, 570, 730]);
    expect(sleep.mock.calls).toEqual([[150], [150]]);
    expect(games.map((candidate) => candidate.protonDb)).toEqual([
      { tier: "silver", confidence: "strong" },
      { tier: "unknown", confidence: "unknown" },
      { tier: "silver", confidence: "strong" },
    ]);
  });

  it("stoppt vor dem ersten request, wenn der lauf stale ist", async () => {
    const { root } = await buildFakeSteam();
    const games = [game(620, root)];
    let calls = 0;
    let settled = 0;
    await enrichProtondb(
      {
        fs: nodeFs(),
        system: fakeSystem(),
        cache: memCache(),
        http: {
          async get() {
            calls++;
            return { status: 404, ok: false, text: "", headers: {} };
          },
        },
      },
      games,
      150,
      { shouldApply: () => false, onSettled: () => settled++ },
    );

    expect(calls).toBe(0);
    expect(settled).toBe(0);
    expect(games[0]?.protonDb).toBeNull();
  });

  it("stoppt nach der pause ohne zweiten request oder callback", async () => {
    vi.useFakeTimers();
    const { root } = await buildFakeSteam();
    const games = [game(620, root), game(570, root)];
    const calls: number[] = [];
    let active = true;
    const run = enrichProtondb(
      {
        fs: nodeFs(),
        system: fakeSystem(),
        cache: memCache(),
        http: {
          async get(url: string) {
            calls.push(Number(url.split("/").at(-1)?.replace(".json", "")));
            return { status: 404, ok: false, text: "", headers: {} };
          },
        },
      },
      games,
      150,
      { shouldApply: () => active, onSettled: () => (active = false) },
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);
    await run;

    expect(calls).toEqual([620]);
    expect(games[0]?.protonDb).toEqual({ tier: "unknown", confidence: "unknown" });
    expect(games[1]?.protonDb).toBeNull();
  });

  it("prüft den guard nach der antwort vor tiermutation", async () => {
    const { root } = await buildFakeSteam();
    const games = [game(620, root)];
    let checks = 0;
    let settled = 0;
    await enrichProtondb(
      {
        fs: nodeFs(),
        system: fakeSystem(),
        cache: memCache(),
        http: {
          async get() {
            return {
              status: 200,
              ok: true,
              text: JSON.stringify({ tier: "gold", confidence: "strong" }),
              headers: {},
            };
          },
        },
      },
      games,
      0,
      { shouldApply: () => checks++ === 0, onSettled: () => settled++ },
    );

    expect(games[0]?.protonDb).toBeNull();
    expect(settled).toBe(0);
    expect(checks).toBe(2);
  });

  it("überspringt lücken eines sparse-arrays statt die anreicherung abzubrechen (K-12)", async () => {
    const { root } = await buildFakeSteam();
    const games = new Array<Game>(3);
    games[1] = game(620, root);
    const settled: number[] = [];
    await enrichProtondb(
      {
        fs: nodeFs(),
        system: fakeSystem(),
        cache: memCache(),
        http: {
          async get() {
            return {
              status: 200,
              ok: true,
              text: JSON.stringify({ tier: "gold", confidence: "strong" }),
              headers: {},
            };
          },
        },
      },
      games,
      0,
      { onSettled: (candidate) => settled.push(candidate.appId) },
    );

    // alt: `return` an der lücke brach die ganze schleife ab, spiel 620 blieb leer.
    expect(settled).toEqual([620]);
    expect(games[1]?.protonDb).toEqual({ tier: "gold", confidence: "strong" });
  });
});
