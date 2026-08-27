import { describe, expect, it } from "vitest";
import { ProtonDbClient } from "../../src/core/protondb.js";
import { fakeHttp, memCache } from "../support/fakeSteam";

const summary = (tier: string, confidence = "strong") => ({
  status: 200,
  ok: true,
  text: JSON.stringify({ tier, confidence }),
  headers: {},
});

const url = (id: number) => `https://www.protondb.com/api/v1/reports/summaries/${id}.json`;

describe("ProtonDbClient", () => {
  it("mappt gültigen tier + confidence", async () => {
    const c = new ProtonDbClient(fakeHttp({ [url(620)]: summary("gold") }), memCache());
    expect(await c.getSummary(620)).toEqual({ tier: "gold", confidence: "strong" });
  });

  it("cache-schreibfehler verwirft frischen report nicht", async () => {
    const cache = memCache();
    cache.set = async () => {
      throw new Error("disk voll");
    };
    const c = new ProtonDbClient(fakeHttp({ [url(620)]: summary("gold") }), cache);
    expect(await c.getSummary(620)).toEqual({ tier: "gold", confidence: "strong" });
  });

  it("kaputter cache → refetch statt fehler", async () => {
    let calls = 0;
    const cache = memCache();
    await cache.set("protondb:620", "{kaputt");
    const http = {
      async get() {
        calls++;
        return summary("gold");
      },
    };
    const c = new ProtonDbClient(http, cache);

    expect(await c.getSummary(620)).toEqual({ tier: "gold", confidence: "strong" });
    expect(calls).toBe(1);
  });

  it("404 → null (→ aufrufer setzt unknown, INV-3)", async () => {
    const c = new ProtonDbClient(fakeHttp(), memCache());
    expect(await c.getSummary(1)).toBeNull();
  });

  it("werfender HTTP-Aufruf → null (offline, INV-3)", async () => {
    const c = new ProtonDbClient(
      {
        async get() {
          throw new Error("offline");
        },
      },
      memCache(),
    );
    expect(await c.getSummary(620)).toBeNull();
  });

  it("ungültiges Antwort-JSON → null (INV-3)", async () => {
    const c = new ProtonDbClient(
      fakeHttp({ [url(620)]: { status: 200, ok: true, text: "{kaputt", headers: {} } }),
      memCache(),
    );
    expect(await c.getSummary(620)).toBeNull();
  });

  it("nicht-string confidence → unknown", async () => {
    const c = new ProtonDbClient(
      fakeHttp({
        [url(620)]: {
          status: 200,
          ok: true,
          text: JSON.stringify({ tier: "gold", confidence: 42 }),
          headers: {},
        },
      }),
      memCache(),
    );
    expect(await c.getSummary(620)).toEqual({ tier: "gold", confidence: "unknown" });
  });

  it("unbekannter tier-string → 'unknown'", async () => {
    const c = new ProtonDbClient(fakeHttp({ [url(9)]: summary("diamond") }), memCache());
    expect((await c.getSummary(9))?.tier).toBe("unknown");
  });

  it("cache-hit vermeidet zweiten http-call innerhalb TTL", async () => {
    let calls = 0;
    const http = {
      async get(_u: string) {
        calls++;
        return summary("platinum");
      },
    };
    const c = new ProtonDbClient(http, memCache());
    await c.getSummary(570);
    await c.getSummary(570);
    expect(calls).toBe(1);
  });

  it("vergifteter cache (tier evil) → normalizeTier → unknown (M4.2)", async () => {
    let calls = 0;
    const http = {
      async get() {
        calls++;
        return summary("platinum");
      },
    };
    const cache = memCache();
    await cache.set(
      "protondb:620",
      JSON.stringify({ tier: "evil", confidence: "x", fetchedAt: 0 }),
    );
    const c = new ProtonDbClient(http, cache, () => 0); // TTL frisch

    const res = await c.getSummary(620);

    expect(res?.tier).toBe("unknown");
    expect(calls).toBe(0); // cache-hit, aber validiert
  });

  it("abgelaufener cache-eintrag → refetch", async () => {
    let calls = 0;
    const http = {
      async get() {
        calls++;
        return summary("silver");
      },
    };
    let t = 0;
    const c = new ProtonDbClient(http, memCache(), () => t);
    await c.getSummary(730);
    t = 8 * 24 * 60 * 60 * 1000; // > 7 tage
    await c.getSummary(730);
    expect(calls).toBe(2);
  });
});
