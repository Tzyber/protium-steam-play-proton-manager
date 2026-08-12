import { describe, expect, it, vi } from "vitest";
import {
  fetchReleases,
  type GeRelease,
  type InstallPhase,
  installRelease,
} from "../../src/core/geproton.js";
import type { FileSystem, Http, HttpResponse, System } from "../../src/core/ports.js";
import { memCache } from "../support/fakeSteam";

function ghBody() {
  return JSON.stringify([
    {
      tag_name: "GE-Proton9-27",
      name: "GE-Proton9-27",
      published_at: "2025-01-01T00:00:00Z",
      body: "x".repeat(400),
      assets: [
        { name: "GE-Proton9-27.tar.gz", browser_download_url: "https://dl/ge.tar.gz", size: 400 },
        { name: "GE-Proton9-27.sha512sum", browser_download_url: "https://dl/ge.sha512sum" },
      ],
    },
    { tag_name: "no-tarball", assets: [] }, // muss rausgefiltert werden
  ]);
}

function httpOnce(response: Partial<HttpResponse>, spy?: () => void): Http {
  return {
    async get() {
      spy?.();
      return { status: 200, ok: true, text: "", headers: {}, ...response };
    },
  };
}

describe("fetchReleases", () => {
  it("parst releases, filtert tarball-lose, kürzt notes", async () => {
    const { releases: rels } = await fetchReleases(
      httpOnce({ text: ghBody(), headers: { etag: '"abc"' } }),
      memCache(),
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]?.tag).toBe("GE-Proton9-27");
    expect(rels[0]?.tarball.url).toBe("https://dl/ge.tar.gz");
    expect(rels[0]?.sha512Url).toBe("https://dl/ge.sha512sum");
    expect(rels[0]?.notes.endsWith("…")).toBe(true);
  });

  it("cache-hit innerhalb TTL vermeidet http", async () => {
    let calls = 0;
    const cache = memCache();
    const http = httpOnce({ text: ghBody(), headers: { etag: '"abc"' } }, () => calls++);
    await fetchReleases(http, cache);
    await fetchReleases(http, cache);
    expect(calls).toBe(1);
  });

  it("force umgeht den cache und fragt trotzdem github", async () => {
    let calls = 0;
    const cache = memCache();
    const http = httpOnce({ text: ghBody(), headers: { etag: '"abc"' } }, () => calls++);
    await fetchReleases(http, cache); // füllt cache
    const res = await fetchReleases(http, cache, Date.now, true); // force trotz frischem cache
    expect(calls).toBe(2);
    expect(res.source).toBe("fresh");
  });

  it("304 → nutzt cache weiter, aktualisiert fetchedAt", async () => {
    const cache = memCache();
    let t = 0;
    let calls = 0;
    const r200: HttpResponse = {
      status: 200,
      ok: true,
      text: ghBody(),
      headers: { etag: '"v1"' },
    };
    const r304: HttpResponse = { status: 304, ok: false, text: "", headers: {} };
    const http: Http = {
      async get(_u, opts) {
        calls++;
        if (calls === 1) return r200;
        expect(opts?.headers?.["If-None-Match"]).toBe('"v1"'); // conditional request
        return r304;
      },
    };
    const { releases: rels1 } = await fetchReleases(http, cache, () => t);
    t = TTL_OVER;
    const { releases: rels2 } = await fetchReleases(http, cache, () => t);
    expect(rels2).toEqual(rels1);
    expect(calls).toBe(2);
  });

  it("cache-schreibfehler verwirft frische releases nicht", async () => {
    const cache = memCache();
    cache.set = async () => {
      throw new Error("disk voll");
    };
    const res = await fetchReleases(
      httpOnce({ text: ghBody(), headers: { etag: '"abc"' } }),
      cache,
      () => 0,
    );
    expect(res.source).toBe("fresh");
    expect(res.releases).toHaveLength(1);
    expect(res.fetchedAt).toBe(0);
  });

  it("304 mit cache-schreibfehler → trotzdem not-modified + fetchedAt", async () => {
    const cache = memCache();
    await cache.set(
      "gh:ge-releases",
      JSON.stringify({ etag: '"v1"', fetchedAt: 0, releases: [release] }),
    );
    cache.set = async () => {
      throw new Error("disk voll");
    };
    const t = TTL_OVER;
    let calls = 0;
    const http: Http = {
      async get() {
        calls++;
        return { status: 304, ok: false, text: "", headers: {} };
      },
    };
    const res = await fetchReleases(http, cache, () => t);
    expect(res.source).toBe("not-modified");
    expect(res.releases).toHaveLength(1);
    expect(res.fetchedAt).toBe(TTL_OVER);
    expect(calls).toBe(1);
  });

  it("403 rate-limit → letzter cache-stand (INV-3)", async () => {
    const cache = memCache();
    let t = 0;
    let first = true;
    const ok: HttpResponse = { status: 200, ok: true, text: ghBody(), headers: {} };
    const limited: HttpResponse = { status: 403, ok: false, text: "rate limit", headers: {} };
    const http: Http = {
      async get() {
        if (first) {
          first = false;
          return ok;
        }
        return limited;
      },
    };
    await fetchReleases(http, cache, () => t);
    t = TTL_OVER;
    const { releases: rels } = await fetchReleases(http, cache, () => t);
    expect(rels).toHaveLength(1); // cache statt leer
  });

  it("cache mit releases:null → wie miss behandelt, nicht durchgereicht (M4.2)", async () => {
    const cache = memCache();
    await cache.set("gh:ge-releases", JSON.stringify({ etag: null, fetchedAt: 0, releases: null }));
    const http: Http = {
      get() {
        return Promise.reject(new Error("offline"));
      },
    };

    const result = await fetchReleases(http, cache);

    expect(result.source).toBe("offline"); // cache wurde verworfen
    expect(result.releases).toEqual([]);
  });

  it("offline ohne cache → [] statt throw", async () => {
    const http: Http = {
      get() {
        return Promise.reject(new Error("offline"));
      },
    };
    expect((await fetchReleases(http, memCache())).releases).toEqual([]);
  });
});

const TTL_OVER = 60 * 60 * 1000 + 1;

const release: GeRelease = {
  tag: "GE-Proton9-27",
  name: "GE-Proton9-27",
  publishedAt: "",
  notes: "",
  tarball: { name: "GE-Proton9-27.tar.gz", url: "https://dl/ge.tar.gz", size: 400 },
  sha512Url: "https://dl/ge.sha512sum",
};

function installMocks(downloadHash: string, sha512Body: string) {
  const removed: string[] = [];
  const extracted: [string, string][] = [];
  const fs = {
    remove: vi.fn(async (p: string) => {
      removed.push(p);
    }),
  } as unknown as FileSystem;
  const http: Http = {
    async get() {
      return { status: 200, ok: true, text: sha512Body, headers: {} };
    },
  };
  const system = {
    downloadFile: vi.fn(async () => downloadHash),
    fetchSha512: vi.fn(async () => sha512Body),
    extractTarball: vi.fn(async (s: string, d: string) => {
      extracted.push([s, d]);
    }),
  } as unknown as System;
  return { fs, http, system, removed, extracted };
}

describe("installRelease", () => {
  const goodHash = "a".repeat(128);

  it("checksum ok → entpackt + räumt tarball auf", async () => {
    const m = installMocks(goodHash, `${goodHash}  GE-Proton9-27.tar.gz`);
    const warnings: string[] = [];
    await installRelease(m, {
      steamRoot: "/root",
      cacheDir: "/cache",
      release,
      downloadId: "1",
      onWarning: () => warnings.push("w"),
    });
    expect(warnings).toHaveLength(0); // erfolgsfall darf nie warnen
    expect(m.extracted).toHaveLength(1);
    expect(m.extracted[0]?.[1]).toBe("/root/compatibilitytools.d");
    expect(m.removed).toContain("/cache/GE-Proton9-27.tar.gz"); // cleanup
  });

  it("checksum-mismatch → wirft + räumt trotzdem auf, kein extract", async () => {
    const m = installMocks(goodHash, `${"b".repeat(128)}  GE-Proton9-27.tar.gz`);
    await expect(
      installRelease(m, { steamRoot: "/root", cacheDir: "/cache", release, downloadId: "1" }),
    ).rejects.toThrow(/checksum/);
    expect(m.extracted).toHaveLength(0);
    expect(m.removed).toContain("/cache/GE-Proton9-27.tar.gz");
  });

  it("onPhase wird in der reihenfolge downloading → verifying → extracting aufgerufen", async () => {
    const m = installMocks(goodHash, `${goodHash}  GE-Proton9-27.tar.gz`);
    const phases: InstallPhase[] = [];
    await installRelease(m, {
      steamRoot: "/root",
      cacheDir: "/cache",
      release,
      downloadId: "1",
      onPhase: (p) => phases.push(p),
    });
    expect(phases).toEqual(["downloading", "verifying", "extracting"]);
  });

  it("ohne onPhase (undefined) läuft installRelease unverändert durch", async () => {
    const m = installMocks(goodHash, `${goodHash}  GE-Proton9-27.tar.gz`);
    await installRelease(m, { steamRoot: "/root", cacheDir: "/cache", release, downloadId: "1" });
    expect(m.extracted).toHaveLength(1); // normaler durchlauf
  });

  it("isCancelled vor dem start → kein download, wirft 'cancelled'", async () => {
    const m = installMocks(goodHash, `${goodHash}  GE-Proton9-27.tar.gz`);
    await expect(
      installRelease(m, {
        steamRoot: "/root",
        cacheDir: "/cache",
        release,
        downloadId: "1",
        isCancelled: () => true,
      }),
    ).rejects.toThrow(/cancel/i);
    expect(m.system.downloadFile).not.toHaveBeenCalled();
    expect(m.extracted).toHaveLength(0);
  });

  it("abbruch während des hash-abrufs verhindert den download noch", async () => {
    const m = installMocks(goodHash, `${goodHash}  GE-Proton9-27.tar.gz`);
    let cancelled = false;
    // flag kippt erst, während fetch_sha512 läuft, genau das fenster, in dem
    // die rust-cancel-registry die id noch nicht kennt
    const system = {
      ...m.system,
      fetchSha512: async () => {
        cancelled = true;
        return `${goodHash}  x.tar.gz`;
      },
    };
    await expect(
      installRelease(
        { ...m, system },
        {
          steamRoot: "/root",
          cacheDir: "/cache",
          release,
          downloadId: "1",
          isCancelled: () => cancelled,
        },
      ),
    ).rejects.toThrow(/cancel/i);
    expect(m.system.downloadFile).not.toHaveBeenCalled();
  });

  it("hash-fetch wirft → onWarning 1×, install ohne prüfung, kein verifying", async () => {
    const m = installMocks(goodHash, `${goodHash}  GE-Proton9-27.tar.gz`);
    const system = {
      ...m.system,
      fetchSha512: vi.fn(async () => {
        throw new Error("netz weg");
      }),
    };
    const warnings: string[] = [];
    const phases: InstallPhase[] = [];
    await installRelease(
      { ...m, system },
      {
        steamRoot: "/root",
        cacheDir: "/cache",
        release,
        downloadId: "1",
        onWarning: () => warnings.push("w"),
        onPhase: (p) => phases.push(p),
      },
    );
    expect(warnings).toHaveLength(1);
    expect(m.extracted).toHaveLength(1);
    expect(phases).toEqual(["downloading", "extracting"]);
  });

  it("hash-fetch !ok → onWarning, install läuft", async () => {
    const m = installMocks(goodHash, `${goodHash}  GE-Proton9-27.tar.gz`);
    const system = {
      ...m.system,
      fetchSha512: vi.fn(async () => {
        throw new Error("HTTP 500"); // rust wirft bei non-success, core fängt
      }),
    };
    const warnings: string[] = [];
    await installRelease(
      { ...m, system },
      {
        steamRoot: "/root",
        cacheDir: "/cache",
        release,
        downloadId: "1",
        onWarning: () => warnings.push("w"),
      },
    );
    expect(warnings).toHaveLength(1);
    expect(m.extracted).toHaveLength(1);
  });

  it("hash-fetch ok, aber text ohne validen hash → onWarning, install läuft", async () => {
    const m = installMocks(goodHash, `${goodHash}  GE-Proton9-27.tar.gz`);
    const system = {
      ...m.system,
      fetchSha512: vi.fn(async () => "kein hash hier"),
    };
    const warnings: string[] = [];
    await installRelease(
      { ...m, system },
      {
        steamRoot: "/root",
        cacheDir: "/cache",
        release,
        downloadId: "1",
        onWarning: () => warnings.push("w"),
      },
    );
    expect(warnings).toHaveLength(1);
    expect(m.extracted).toHaveLength(1);
  });

  it("kein sha512-asset → kein onWarning, install läuft ohne prüfung", async () => {
    const m = installMocks(goodHash, `${goodHash}  GE-Proton9-27.tar.gz`);
    const warnings: string[] = [];
    await installRelease(m, {
      steamRoot: "/root",
      cacheDir: "/cache",
      release: { ...release, sha512Url: null },
      downloadId: "1",
      onWarning: () => warnings.push("w"),
    });
    expect(warnings).toHaveLength(0);
    expect(m.extracted).toHaveLength(1);
  });
});
