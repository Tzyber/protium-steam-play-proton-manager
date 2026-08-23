import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichProtondb } from "../../../src/core/scan/protondb.js";
import type { Game } from "../../../src/core/types.js";
import { buildFakeSteam, fakeSystem, memCache, nodeFs } from "../../support/fakeSteam";

const game = (appId: number, library = "/steam"): Game => ({
  appId,
  name: `game-${appId}`,
  library,
  sizeBytes: 0,
  compatTool: "default",
  compatToolSource: "default",
  protonDb: null,
  localHeader: null,
  headerImage: null,
});

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

  it("wartet 150 ms nur zwischen spiel-abwicklungen, auch bei cache-hits", async () => {
    vi.useFakeTimers();
    const { root } = await buildFakeSteam();
    const games = [game(620, root), game(570, root), game(730, root)];
    const calls: number[] = [];
    const settled: number[] = [];
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

    const run = enrichProtondb(ports, games, 150, {
      onSettled: (candidate) => settled.push(candidate.appId),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    expect(settled).toEqual([620]);

    await vi.advanceTimersByTimeAsync(149);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual([620, 570]);
    await vi.advanceTimersByTimeAsync(150);
    expect(settled).toEqual([620, 570, 730]);
    await run;

    expect(calls).toEqual([]);
    expect(games.every((candidate) => candidate.protonDb?.tier === "gold")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
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
});
