import {
  fetchReleases,
  type GeRelease,
  installRelease,
  isManagedGeName,
  parseReleases,
} from "../../src/core/geproton.js";
import type {
  GeInstallParams,
  Http,
  HttpResponse,
  System,
  TargetArch,
} from "../../src/core/ports.js";
import { memCache } from "../support/fakeSteam";

const X86_64: TargetArch = "x86_64";
const AARCH64: TargetArch = "aarch64";

describe("isManagedGeName", () => {
  it("akzeptiert gültige GE-Namen", () => {
    expect(isManagedGeName("GE-Proton9-27")).toBe(true);
    expect(isManagedGeName("GE-Proton10-25")).toBe(true);
    expect(isManagedGeName("GE-Proton11-4-x86_64")).toBe(true);
    expect(isManagedGeName("GE-Proton11-5-aarch64")).toBe(true);
    expect(isManagedGeName("GE-Proton11-3")).toBe(true);
  });

  it("lehnt ungültige oder manipulierte Namen ab", () => {
    expect(isManagedGeName("Proton")).toBe(false);
    expect(isManagedGeName("GE-Proton")).toBe(false);
    expect(isManagedGeName("GE-Proton10")).toBe(false);
    expect(isManagedGeName("ge-proton9-27")).toBe(false);
    expect(isManagedGeName("GE-Proton9-27-custom")).toBe(false);
    expect(isManagedGeName("GE-Proton11-5-arm64")).toBe(false);
    expect(isManagedGeName("GE-Proton11-4")).toBe(false);
    expect(isManagedGeName("../GE-Proton9-27")).toBe(false);
    expect(isManagedGeName("GE-Proton9-27/bad")).toBe(false);
    expect(isManagedGeName("GE-Proton9-27\0")).toBe(false);
    expect(isManagedGeName("GE-\u0420roton9-27")).toBe(false);
  });
});

function ghBody() {
  return JSON.stringify([
    {
      tag_name: "GE-Proton9-27",
      name: "GE-Proton9-27",
      published_at: "2025-01-01T00:00:00Z",
      body: "x".repeat(400),
      assets: [
        {
          name: "GE-Proton9-27.tar.gz",
          browser_download_url:
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
          size: 400,
        },
        {
          name: "GE-Proton9-27.sha512sum",
          browser_download_url:
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.sha512sum",
        },
      ],
    },
    {
      tag_name: "GE-Proton11-4",
      name: "GE-Proton11-4 Released",
      published_at: "2025-02-01T00:00:00Z",
      body: "release 11-4",
      assets: [
        {
          name: "GE-Proton11-4-aarch64.tar.gz",
          browser_download_url:
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-aarch64.tar.gz",
          size: 400,
        },
        {
          name: "GE-Proton11-4-aarch64.sha512sum",
          browser_download_url:
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-aarch64.sha512sum",
        },
        {
          name: "GE-Proton11-4-x86_64.tar.gz",
          browser_download_url:
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz",
          size: 500,
        },
        {
          name: "GE-Proton11-4-x86_64.sha512sum",
          browser_download_url:
            "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.sha512sum",
        },
      ],
    },
    { tag_name: "no-tarball", assets: [] }, // muss rausgefiltert werden
    {
      tag_name: "Proton-Custom",
      assets: [
        {
          name: "Proton-Custom.tar.gz",
          browser_download_url: "https://dl/custom.tar.gz",
          size: 100,
        },
      ],
    },
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
  it("parst releases, filtert tarball-lose und nicht-GE namen, kürzt notes", async () => {
    const { releases: rels } = await fetchReleases(
      httpOnce({ text: ghBody(), headers: { etag: '"abc"' } }),
      memCache(),
      X86_64,
    );
    expect(rels).toHaveLength(2);
    expect(rels[0]?.tag).toBe("GE-Proton9-27");
    expect(rels[0]?.installName).toBe("GE-Proton9-27");
    expect(rels[0]?.tarball.url).toBe(
      "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
    );
    expect(rels[0]?.sha512Url).toBe(
      "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.sha512sum",
    );
    expect(rels[0]?.notes.endsWith("…")).toBe(true);

    expect(rels[1]?.tag).toBe("GE-Proton11-4");
    expect(rels[1]?.installName).toBe("GE-Proton11-4-x86_64");
    expect(rels[1]?.tarball.url).toBe(
      "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz",
    );
    expect(rels[1]?.sha512Url).toBe(
      "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.sha512sum",
    );
  });

  it("filtert exakt nach backendarchitektur und erlaubt legacy nur für x86_64", () => {
    const x86 = parseReleases(ghBody(), X86_64);
    const arm = parseReleases(ghBody(), AARCH64);

    expect(x86.map((release) => release.installName)).toEqual([
      "GE-Proton9-27",
      "GE-Proton11-4-x86_64",
    ]);
    expect(arm.map((release) => release.installName)).toEqual(["GE-Proton11-4-aarch64"]);
  });

  it("verwirft gekreuzte, zusätzliche und encodierte asset-urls", () => {
    const raw = JSON.parse(ghBody()) as Array<{
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string; size?: number }>;
    }>;
    const current = raw[1];
    if (!current) throw new Error("fixture release fehlt");
    current.assets[0] = {
      name: "GE-Proton11-4-aarch64.tar.gz",
      browser_download_url:
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton%31%31-4/GE-Proton11-4-aarch64.tar.gz",
    };
    current.assets[1] = {
      name: "GE-Proton11-4-x86_64.sha512sum",
      browser_download_url:
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.sha512sum?cache=1",
    };
    current.assets[2] = {
      name: "GE-Proton11-4-x86_64.tar.gz",
      browser_download_url:
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-4/GE-Proton11-4-x86_64.tar.gz/extra",
      size: 500,
    };
    expect(parseReleases(JSON.stringify(raw), X86_64).map((release) => release.tag)).toEqual([
      "GE-Proton9-27",
    ]);
  });

  it("cache-hit innerhalb TTL vermeidet http", async () => {
    let calls = 0;
    const cache = memCache();
    const http = httpOnce({ text: ghBody(), headers: { etag: '"abc"' } }, () => calls++);
    await fetchReleases(http, cache, X86_64);
    await fetchReleases(http, cache, X86_64);
    expect(calls).toBe(1);
  });

  it("force umgeht den cache und fragt trotzdem github", async () => {
    let calls = 0;
    const cache = memCache();
    const http = httpOnce({ text: ghBody(), headers: { etag: '"abc"' } }, () => calls++);
    await fetchReleases(http, cache, X86_64); // füllt cache
    const res = await fetchReleases(http, cache, X86_64, Date.now, true); // force trotz frischem cache
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
    const { releases: rels1 } = await fetchReleases(http, cache, X86_64, () => t);
    t = TTL_OVER;
    const { releases: rels2 } = await fetchReleases(http, cache, X86_64, () => t);
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
      X86_64,
      () => 0,
    );
    expect(res.source).toBe("fresh");
    expect(res.releases).toHaveLength(2);
    expect(res.fetchedAt).toBe(0);
  });

  it("304 mit cache-schreibfehler → trotzdem not-modified + fetchedAt", async () => {
    const cache = memCache();
    await cache.set(
      "gh:ge-releases:x86_64",
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
    const res = await fetchReleases(http, cache, X86_64, () => t);
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
    await fetchReleases(http, cache, X86_64, () => t);
    t = TTL_OVER;
    const { releases: rels } = await fetchReleases(http, cache, X86_64, () => t);
    expect(rels).toHaveLength(2); // cache statt leer
  });

  it("cache mit releases:null → wie miss behandelt, nicht durchgereicht (M4.2)", async () => {
    const cache = memCache();
    await cache.set(
      "gh:ge-releases:x86_64",
      JSON.stringify({ etag: null, fetchedAt: 0, releases: null }),
    );
    const http: Http = {
      get() {
        return Promise.reject(new Error("offline"));
      },
    };

    const result = await fetchReleases(http, cache, X86_64);

    expect(result.source).toBe("offline"); // cache wurde verworfen
    expect(result.releases).toEqual([]);
  });

  it("offline ohne cache → [] statt throw", async () => {
    const http: Http = {
      get() {
        return Promise.reject(new Error("offline"));
      },
    };
    expect((await fetchReleases(http, memCache(), X86_64)).releases).toEqual([]);
  });
});

const TTL_OVER = 60 * 60 * 1000 + 1;

const release: GeRelease = {
  tag: "GE-Proton9-27",
  name: "GE-Proton9-27",
  installName: "GE-Proton9-27",
  publishedAt: "",
  notes: "",
  tarball: {
    name: "GE-Proton9-27.tar.gz",
    url: "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
    size: 400,
  },
  sha512Url:
    "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.sha512sum",
};

function installMocks(result: "verified" | "unverified" | Error = "verified") {
  const installCalls: GeInstallParams[] = [];
  const system = {
    installGeProton: vi.fn(async (params: GeInstallParams) => {
      installCalls.push(params);
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as System;
  return { system, installCalls };
}

describe("installRelease", () => {
  it("checksum ok / verified → ruft backend auf, keine warnung", async () => {
    const m = installMocks("verified");
    const warnings: string[] = [];
    await installRelease(m, {
      steamRoot: "/root",
      release,
      downloadId: "1",
      onWarning: () => warnings.push("w"),
    });
    expect(warnings).toHaveLength(0);
    expect(m.installCalls).toHaveLength(1);
    expect(m.installCalls[0]).toEqual({
      steamRoot: "/root",
      releaseTag: "GE-Proton9-27",
      downloadUrl:
        "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
      downloadId: "1",
    });
  });

  it("checksum-mismatch → backend wirft fehler", async () => {
    const m = installMocks(new Error("SHA512 hash mismatch"));
    await expect(
      installRelease(m, { steamRoot: "/root", release, downloadId: "1" }),
    ).rejects.toThrow(/mismatch/i);
    expect(m.installCalls).toHaveLength(1);
  });

  it("isCancelled vor dem start → kein backend-aufruf, wirft 'cancelled'", async () => {
    const m = installMocks("verified");
    await expect(
      installRelease(m, {
        steamRoot: "/root",
        release,
        downloadId: "1",
        isCancelled: () => true,
      }),
    ).rejects.toThrow(/cancel/i);
    expect(m.installCalls).toHaveLength(0);
  });

  it("backend meldet unverified unabhängig vom Webview-sha-feld → löst onWarning aus", async () => {
    const m = installMocks("unverified");
    const warnings: string[] = [];
    await installRelease(m, {
      steamRoot: "/root",
      release,
      downloadId: "1",
      onWarning: () => warnings.push("w"),
    });
    expect(warnings).toHaveLength(1);
    expect(m.installCalls).toHaveLength(1);
  });

  it("sha512Url-null im Release ist keine Autorität über unverified", async () => {
    const m = installMocks("unverified");
    const warnings: string[] = [];
    await installRelease(m, {
      steamRoot: "/root",
      release: { ...release, sha512Url: null },
      downloadId: "1",
      onWarning: () => warnings.push("w"),
    });
    expect(warnings).toHaveLength(1);
    expect(m.installCalls).toHaveLength(1);
  });
});
