import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeRelease } from "../../src/core/geproton";
import { setLocale } from "../../src/ui/i18n";

const {
  mockAppCacheDir,
  mockDownloadFile,
  mockExtractTarball,
  mockFetchSha512,
  mockHttpGet,
  mockListen,
} = vi.hoisted(() => ({
  mockAppCacheDir: vi.fn(async () => "/tmp/cache"),
  mockDownloadFile: vi.fn(async () => "a".repeat(128)),
  mockExtractTarball: vi.fn<() => Promise<void>>(),
  mockFetchSha512: vi.fn(async () => `${"a".repeat(128)}  x.tar.gz`),
  mockHttpGet: vi.fn(async () => ({
    status: 200,
    ok: true,
    text: `${"a".repeat(128)}  x.tar.gz`,
    headers: {},
  })),
  mockListen: vi.fn(async () => () => {}),
}));

vi.mock("../../src/core/adapters/tauri", async () => {
  return {
    appCacheDir: mockAppCacheDir,
    tauriPorts: {
      fs: { remove: vi.fn(async () => {}) },
      http: {
        get: mockHttpGet,
      },
      system: {
        downloadFile: mockDownloadFile,
        fetchSha512: mockFetchSha512,
        extractTarball: mockExtractTarball,
        removeCompatTool: vi.fn(async () => {}),
        cancelDownload: vi.fn(async () => {}),
      },
      cache: {},
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

import { useProtonStore } from "../../src/ui/stores/protonStore";
import { useScanStore } from "../../src/ui/stores/scanStore";

const release: GeRelease = {
  tag: "GE-Proton9-27",
  name: "GE-Proton9-27",
  publishedAt: "",
  notes: "",
  tarball: { name: "GE-Proton9-27.tar.gz", url: "https://dl/ge.tar.gz", size: 400 },
  sha512Url: null,
};

function fakeScanResult() {
  return {
    steamRoot: "/root",
    libraries: [],
    games: [],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: null,
    steamUserId: null,
    warnings: [],
    skippedLibraries: [],
  };
}

describe("protonStore init + pump-robustheit", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockListen.mockReset();
    mockListen.mockResolvedValue(() => {});
    mockDownloadFile.mockClear();
    mockExtractTarball.mockClear();
    mockFetchSha512.mockClear();
    mockHttpGet.mockClear();
    mockAppCacheDir.mockClear();
    mockAppCacheDir.mockResolvedValue("/tmp/cache");
    mockExtractTarball.mockImplementation(() => new Promise(() => {})); // blockiert
  });

  it("init: listener-fehler → keine unhandled rejection, releases laden trotzdem, retry möglich", async () => {
    mockListen.mockRejectedValueOnce(new Error("event api unavailable"));
    const store = useProtonStore();
    const loadReleases = vi.fn(async () => {});
    store.loadReleases = loadReleases;

    await store.init();

    expect(store.listenerReady).toBe(false);
    expect(loadReleases).toHaveBeenCalledTimes(1);
  });

  it("init: erfolgreicher listener → kein erneutes listen beim zweiten aufruf", async () => {
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});

    await store.init();
    await store.init();

    expect(store.listenerReady).toBe(true);
    expect(mockListen).toHaveBeenCalledTimes(1);
  });

  it("pump: release nicht (mehr) in der liste → job-leiche wird aufgeräumt, queue hängt nicht", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    const store = useProtonStore();
    store.releases = []; // z. B. direkt nach mount, releases noch nicht geladen

    store.queueInstall(release);
    await vi.waitFor(() => {
      expect(store.jobs[release.tag]).toBeUndefined();
    });
    expect(store.activeTag).toBeNull();

    // und der nächste gültige eintrag startet ganz normal
    store.releases = [release];
    store.queueInstall(release);
    await vi.waitFor(() => {
      expect(store.activeTag).toBe(release.tag);
    });
  });
});

describe("protonStore pump-phasen", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    // aufruf-historie zurücksetzen, der vorherige test lässt einen laufenden
    // job stehen, sonst zählen dessen aufrufe hier mit
    mockDownloadFile.mockClear();
    mockExtractTarball.mockClear();
    mockFetchSha512.mockClear();
    mockHttpGet.mockClear();
    mockAppCacheDir.mockClear();
    mockDownloadFile.mockResolvedValue("a".repeat(128));
    mockExtractTarball.mockImplementation(() => new Promise(() => {})); // blockiert
    mockAppCacheDir.mockResolvedValue("/tmp/cache");
  });

  it("phase ist 'extracting' während blockierendem extractTarball", async () => {
    const scanStore = useScanStore();
    scanStore.result = {
      steamRoot: "/root",
      libraries: [],
      games: [],
      compatToolsInstalled: [],
      builtinProtonsInstalled: [],
      defaultCompatTool: null,
      steamUserId: null,
      warnings: [],
      skippedLibraries: [],
    };

    const store = useProtonStore();
    store.releases = [release];
    store.queueInstall(release);

    await vi.waitFor(
      () => {
        expect(store.jobs[release.tag]?.phase).toBe("extracting");
      },
      { timeout: 2000 },
    );
  });

  it("abbruch im fenster vor der backend-registrierung verhindert den download", async () => {
    const scanStore = useScanStore();
    scanStore.result = {
      steamRoot: "/root",
      libraries: [],
      games: [],
      compatToolsInstalled: [],
      builtinProtonsInstalled: [],
      defaultCompatTool: null,
      steamUserId: null,
      warnings: [],
      skippedLibraries: [],
    };

    // appCacheDir hängt → pump steht VOR installRelease, die cancel-registry im
    // backend kennt die id also noch nicht. cancelDownload allein wäre hier
    // wirkungslos.
    let letCacheDirResolve: (v: string) => void = () => {};
    mockAppCacheDir.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          letCacheDirResolve = resolve;
        }),
    );

    const store = useProtonStore();
    store.releases = [release];
    store.queueInstall(release);

    await vi.waitFor(() => {
      expect(store.activeTag).toBe(release.tag);
    });

    await store.cancel(release.tag);
    letCacheDirResolve("/tmp/cache");

    await vi.waitFor(() => {
      expect(store.jobs[release.tag]).toBeUndefined();
    });
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(store.loadError).toBeNull(); // abbruch ist kein fehler
  });
});

describe("protonStore warnung (sha512-fetch-fehler)", () => {
  const withSha = { ...release, sha512Url: "https://dl/ge.sha512sum" };

  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockDownloadFile.mockClear();
    mockExtractTarball.mockClear();
    mockAppCacheDir.mockClear();
    mockHttpGet.mockReset(); // once-queue aus abgebrochenen tests leeren
    mockFetchSha512.mockReset(); // once-queue aus abgebrochenen tests leeren
    mockFetchSha512.mockResolvedValue(`${"a".repeat(128)}  x.tar.gz`);
    mockHttpGet.mockResolvedValue({
      status: 200,
      ok: true,
      text: `${"a".repeat(128)}  x.tar.gz`,
      headers: {},
    });
    mockDownloadFile.mockResolvedValue("a".repeat(128));
    mockExtractTarball.mockImplementation(() => new Promise(() => {})); // blockiert
    mockAppCacheDir.mockResolvedValue("/tmp/cache");
  });

  function installWithSha() {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    // läuft in pump echt und importiert getHome von der gemockten datei →
    // ungemockt wirft runScan intern (getHome undefined). explizit stubben.
    scanStore.runScan = vi.fn(async () => {});
    const store = useProtonStore();
    store.releases = [withSha];
    return store;
  }

  it("clearWarning entfernt die warnung (wegklickbar über das ×)", () => {
    const store = installWithSha();
    store.warning = { tag: withSha.tag, msg: "alte warnung" };
    store.clearWarning();
    expect(store.warning).toBeNull();
  });

  it("verified-flag beim entpacken, wenn sha512-asset vorhanden und geprüft", async () => {
    // kontrollierbares entpacken: installRelease hält das promise vom AUFRUF
    // impl später tauschen würde den laufenden await nicht auflösen
    let finish: (() => void) | undefined;
    mockExtractTarball.mockImplementation(
      () =>
        new Promise<void>((res) => {
          finish = res;
        }),
    );
    const store = installWithSha();
    store.queueInstall(withSha);
    await vi.waitFor(() => {
      expect(store.jobs[withSha.tag]?.phase).toBe("extracting");
    });
    expect(store.jobs[withSha.tag]?.verified).toBe(true);
    finish?.(); // entpacken freigeben → job räumt auf
    await vi.waitFor(() => {
      expect(store.jobs[withSha.tag]).toBeUndefined();
    });
  });

  it("fetch-fail + install erfolgreich → warning mit tag gesetzt", async () => {
    mockFetchSha512.mockRejectedValueOnce(new Error("netz weg"));
    mockExtractTarball.mockResolvedValue(undefined); // install läuft durch
    const store = installWithSha();

    store.queueInstall(withSha);

    await vi.waitFor(() => {
      expect(store.jobs[withSha.tag]).toBeUndefined();
    });
    // literal gepinnt statt t()-vergleich: würde der key oder {tag}-parameter
    // wegfallen (fallback = key-literal), muss der test rot werden
    expect(store.warning).toEqual({
      tag: withSha.tag,
      msg: "GE-Proton9-27 ohne Verifikation installiert (Prüfsumme nicht abrufbar)",
    });
  });

  it("verifizierter reinstall desselben tags räumt alte warnung + loadError", async () => {
    mockExtractTarball.mockResolvedValue(undefined); // install läuft durch
    const store = installWithSha();
    store.warning = { tag: withSha.tag, msg: "alte warnung" };
    store.loadError = "alter fehler";

    store.queueInstall(withSha);

    await vi.waitFor(() => {
      expect(store.jobs[withSha.tag]).toBeUndefined();
    });
    expect(store.warning).toBeNull(); // verifiziert → keine warnung mehr
    expect(store.loadError).toBeNull(); // stale fehlermeldung weg
  });

  it("fetch-fail + download-fail → keine warning neben loadError", async () => {
    mockFetchSha512.mockRejectedValueOnce(new Error("netz weg"));
    mockDownloadFile.mockRejectedValueOnce(new Error("download kaputt"));
    const store = installWithSha();

    store.queueInstall(withSha);

    await vi.waitFor(() => {
      expect(store.jobs[withSha.tag]).toBeUndefined();
    });
    expect(store.warning).toBeNull();
    expect(store.loadError).not.toBeNull();
  });
});
