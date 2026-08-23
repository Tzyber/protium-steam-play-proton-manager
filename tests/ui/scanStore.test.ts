import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSnapshot } from "../../src/core/ports";
import type { scanLocal } from "../../src/core/scan/local";
import type { enrichProtondb } from "../../src/core/scan/protondb";
import type { ScanResult } from "../../src/core/types";
import { setLocale } from "../../src/ui/i18n";

const { mockDiscoverEnvironment, mockScanLocal, mockEnrichProtondb } = vi.hoisted(() => ({
  mockDiscoverEnvironment: vi.fn<() => Promise<EnvironmentSnapshot>>(async () => ({
    generation: 1,
    steamRoot: "/home/u/.steam",
    libraries: ["/home/u/.steam"],
    systemCompatDirs: [],
    appCacheDir: "/home/u/.cache/protium",
    appConfigDir: "/home/u/.config/protium",
  })),
  mockScanLocal: vi.fn<typeof scanLocal>(),
  mockEnrichProtondb: vi.fn<typeof enrichProtondb>(async () => {}),
}));

vi.mock("../../src/core/adapters/tauri", () => ({
  tauriPorts: {
    fs: {},
    http: {},
    system: {
      geTargetArch: vi.fn(async () => "x86_64" as const),
      discoverSteamEnvironment: mockDiscoverEnvironment,
    },
    cache: {},
  },
}));
vi.mock("../../src/core/scan/local", () => ({
  scanLocal: mockScanLocal,
}));
vi.mock("../../src/core/scan/protondb", () => ({
  enrichProtondb: mockEnrichProtondb,
}));

import { useScanStore } from "../../src/ui/stores/scanStore";

function fakeResult(): ScanResult {
  return {
    steamRoot: "/home/u/.steam",
    libraries: ["/home/u/.steam"],
    games: [
      {
        appId: 42,
        name: "Game 42",
        library: "/home/u/.steam",
        sizeBytes: 100,
        compatTool: "default",
        compatToolSource: "default",
        protonDb: null,
        localHeader: null,
        headerImage: null,
      },
    ],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: null,
    compatConfigStatus: "available",
    steamUserId: null,
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
  };
}

function fakeLocalResult(result = fakeResult()): Awaited<ReturnType<typeof scanLocal>> {
  return {
    libraries: result.libraries,
    games: result.games,
    compatToolsInstalled: result.compatToolsInstalled,
    builtinProtonsInstalled: result.builtinProtonsInstalled,
    defaultCompatTool: result.defaultCompatTool,
    compatConfigStatus: result.compatConfigStatus,
    steamUserId: result.steamUserId,
    warnings: result.warnings,
    skippedLibraries: result.skippedLibraries,
    cleanupUnsafeLibraries: result.cleanupUnsafeLibraries,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe("scanStore.runScan", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockDiscoverEnvironment.mockReset();
    mockDiscoverEnvironment.mockResolvedValue({
      generation: 1,
      steamRoot: "/home/u/.steam",
      libraries: ["/home/u/.steam"],
      systemCompatDirs: [],
      appCacheDir: "/home/u/.cache/protium",
      appConfigDir: "/home/u/.config/protium",
    });
    mockScanLocal.mockReset();
    mockScanLocal.mockResolvedValue(fakeLocalResult());
    mockEnrichProtondb.mockReset();
    mockEnrichProtondb.mockResolvedValue();
  });

  it("happy path: scanning → done, result gesetzt, fehler zurückgesetzt", async () => {
    const store = useScanStore();
    store.error = "alter fehler";

    await store.runScan();

    expect(store.status).toBe("done");
    expect(store.result?.games).toHaveLength(1);
    expect(store.error).toBeNull();
    expect(store.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(store.games[0]?.appId).toBe(42);
  });

  it("SteamNotFoundError → status not-found, kein error-text", async () => {
    mockDiscoverEnvironment.mockRejectedValue("steam installation not found");
    const store = useScanStore();

    await store.runScan();

    expect(store.status).toBe("not-found");
    expect(store.error).toBeNull();
    expect(store.result).toBeNull();
    expect(mockScanLocal).not.toHaveBeenCalled();
  });

  it("generischer fehler → status error + meldung", async () => {
    mockScanLocal.mockRejectedValue(new Error("kaputt"));
    const store = useScanStore();

    await store.runScan();

    expect(store.status).toBe("error");
    expect(store.error).toBe("kaputt");
  });

  it("string-rejection (tauri-invoke) landet lesbar in error", async () => {
    // tauri-invoke rejectet mit strings, nicht mit Error-objekten (A3)
    mockDiscoverEnvironment.mockRejectedValue("forbidden path: /home/u");
    const store = useScanStore();

    await store.runScan();

    expect(store.status).toBe("error");
    expect(store.error).toBe("forbidden path: /home/u");
  });

  it("setzt lokales resultat vor dem deferred protondb-nachlauf", async () => {
    const local = deferred<Awaited<ReturnType<typeof scanLocal>>>();
    const enrich = deferred<void>();
    mockScanLocal.mockReturnValue(local.promise);
    mockEnrichProtondb.mockReturnValue(enrich.promise);
    const store = useScanStore();

    const run = store.runScan();
    local.resolve(fakeLocalResult());
    await run;

    expect(store.status).toBe("done");
    expect(store.result?.games).toHaveLength(1);
    expect(store.protonDbRemaining).toBe(1);
    expect(mockEnrichProtondb).toHaveBeenCalledTimes(1);

    enrich.resolve();
    await vi.waitFor(() => expect(store.protonDbRemaining).toBe(0));
  });

  it("stale discovery-erfolg startet keinen lokalen scan", async () => {
    const first = deferred<EnvironmentSnapshot>();
    const second = deferred<EnvironmentSnapshot>();
    mockDiscoverEnvironment.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = useScanStore();

    const oldRun = store.runScan();
    const newRun = store.runScan();
    first.resolve({
      generation: 1,
      steamRoot: "/old",
      libraries: ["/old"],
      systemCompatDirs: [],
      appCacheDir: "/cache",
      appConfigDir: "/config",
    });
    await oldRun;
    expect(mockScanLocal).not.toHaveBeenCalled();

    second.resolve({
      generation: 2,
      steamRoot: "/new",
      libraries: ["/new"],
      systemCompatDirs: [],
      appCacheDir: "/cache",
      appConfigDir: "/config",
    });
    await newRun;

    expect(mockScanLocal).toHaveBeenCalledTimes(1);
    expect(store.result?.steamRoot).toBe("/new");
  });

  it("stale discovery-fehler mutiert status, error, elapsed und notification nicht", async () => {
    const first = deferred<EnvironmentSnapshot>();
    const second = deferred<EnvironmentSnapshot>();
    mockDiscoverEnvironment.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = useScanStore();
    store.elapsedMs = 123;

    const oldRun = store.runScan();
    const newRun = store.runScan();
    first.reject("alter discovery-fehler");
    await oldRun;

    expect(store.status).toBe("scanning");
    expect(store.error).toBeNull();
    expect(store.elapsedMs).toBe(0);

    second.resolve({
      generation: 2,
      steamRoot: "/new",
      libraries: ["/new"],
      systemCompatDirs: [],
      appCacheDir: "/cache",
      appConfigDir: "/config",
    });
    await newRun;
  });

  it("stale local-erfolg ersetzt kein neues resultat", async () => {
    const oldLocal = deferred<Awaited<ReturnType<typeof scanLocal>>>();
    const newLocal = deferred<Awaited<ReturnType<typeof scanLocal>>>();
    mockScanLocal.mockReturnValueOnce(oldLocal.promise).mockReturnValueOnce(newLocal.promise);
    const store = useScanStore();

    const oldRun = store.runScan();
    await vi.waitFor(() => expect(mockScanLocal).toHaveBeenCalledTimes(1));
    const newRun = store.runScan();
    oldLocal.resolve(fakeLocalResult({ ...fakeResult(), steamRoot: "/old" }));
    await oldRun;

    expect(store.result).toBeNull();
    expect(store.status).toBe("scanning");

    newLocal.resolve(fakeLocalResult({ ...fakeResult(), steamRoot: "/new" }));
    await newRun;
    expect(store.result?.steamRoot).toBe("/home/u/.steam");
  });

  it("stale local-fehler mutiert keinen laufenden neuen status oder finally-wert", async () => {
    const oldLocal = deferred<Awaited<ReturnType<typeof scanLocal>>>();
    const newLocal = deferred<Awaited<ReturnType<typeof scanLocal>>>();
    mockScanLocal.mockReturnValueOnce(oldLocal.promise).mockReturnValueOnce(newLocal.promise);
    const store = useScanStore();
    store.elapsedMs = 321;

    const oldRun = store.runScan();
    await vi.waitFor(() => expect(mockScanLocal).toHaveBeenCalledTimes(1));
    const newRun = store.runScan();
    oldLocal.reject(new Error("alter lokaler fehler"));
    await oldRun;

    expect(store.status).toBe("scanning");
    expect(store.error).toBeNull();
    expect(store.elapsedMs).toBe(0);

    newLocal.resolve(fakeLocalResult());
    await newRun;
  });

  it("stale enrich-callbacks und finalisierung mutieren neues resultat nicht", async () => {
    const oldEnrich = deferred<void>();
    const newEnrich = deferred<void>();
    let oldOptions: Parameters<typeof enrichProtondb>[3] | undefined;
    let newOptions: Parameters<typeof enrichProtondb>[3] | undefined;
    mockEnrichProtondb
      .mockImplementationOnce(async (_ports, _games, _delay, options) => {
        oldOptions = options;
        await oldEnrich.promise;
      })
      .mockImplementationOnce(async (_ports, _games, _delay, options) => {
        newOptions = options;
        await newEnrich.promise;
      });
    const store = useScanStore();

    const oldRun = store.runScan();
    await oldRun;
    const oldResult = store.result;
    expect(oldResult).not.toBeNull();
    expect(store.protonDbRemaining).toBe(1);

    const newRun = store.runScan();
    await newRun;
    const newResult = store.result;
    expect(newResult).not.toBe(oldResult);
    expect(store.protonDbRemaining).toBe(1);

    oldOptions?.onSettled?.(oldResult?.games[0] as NonNullable<typeof oldResult>["games"][number]);
    oldEnrich.resolve();
    await vi.waitFor(() => expect(mockEnrichProtondb).toHaveBeenCalledTimes(2));
    expect(store.result).toBe(newResult);
    expect(store.protonDbRemaining).toBe(1);

    newOptions?.onSettled?.(newResult?.games[0] as NonNullable<typeof newResult>["games"][number]);
    expect(store.protonDbRemaining).toBe(0);
    newEnrich.resolve();
    await vi.waitFor(() => expect(store.protonDbRemaining).toBe(0));
  });

  it("resultatidentität schützt den nachlauf auch innerhalb derselben generation", async () => {
    const enrich = deferred<void>();
    let options: Parameters<typeof enrichProtondb>[3] | undefined;
    mockEnrichProtondb.mockImplementation(async (_ports, _games, _delay, receivedOptions) => {
      options = receivedOptions;
      await enrich.promise;
    });
    const store = useScanStore();
    await store.runScan();
    const original = store.result;
    store.result = fakeResult();
    const replacement = store.result;

    expect(options?.shouldApply?.()).toBe(false);
    options?.onSettled?.(replacement.games[0] as (typeof replacement.games)[number]);
    enrich.resolve();
    await vi.waitFor(() => expect(store.protonDbRemaining).toBe(1));
    expect(store.result).toBe(replacement);
    expect(store.result).not.toBe(original);
  });

  it("protondb-fortschritt zählt callbacks und offline unknown ohne globalen fehler", async () => {
    mockEnrichProtondb.mockImplementation(async (_ports, games, _delay, options) => {
      for (const game of games) {
        game.protonDb = { tier: "unknown", confidence: "unknown" };
        options?.onSettled?.(game);
      }
    });
    const store = useScanStore();

    await store.runScan();

    expect(store.status).toBe("done");
    expect(store.error).toBeNull();
    expect(store.protonDbRemaining).toBe(0);
    expect(store.result?.games[0]?.protonDb).toEqual({ tier: "unknown", confidence: "unknown" });
  });

  it("null spiele starten keinen nachlauf und schließen reststatus sofort", async () => {
    const empty = fakeResult();
    empty.games = [];
    mockScanLocal.mockResolvedValue(fakeLocalResult(empty));
    const store = useScanStore();

    await store.runScan();

    expect(store.status).toBe("done");
    expect(store.protonDbRemaining).toBe(0);
    expect(mockEnrichProtondb).not.toHaveBeenCalled();
  });

  it("unerwarteter background-reject bleibt lokal done und wird abgefangen", async () => {
    mockEnrichProtondb.mockRejectedValue(new Error("protondb kaputt"));
    const store = useScanStore();

    await store.runScan();
    await vi.waitFor(() => expect(store.protonDbRemaining).toBe(0));

    expect(store.status).toBe("done");
    expect(store.error).toBeNull();
    expect(store.result?.games).toHaveLength(1);
  });
});

describe("scanStore.applyGameConfig", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
  });

  it("schreibt launchOptions + compatTool ins passende spiel", () => {
    const store = useScanStore();
    store.result = fakeResult();

    store.applyGameConfig(42, { launchOptions: "-novid", compatTool: "GE-Proton10-1" });

    const g = store.result.games[0] as (typeof store.result.games)[number];
    expect(g.launchOptions).toBe("-novid");
    expect(g.compatTool).toBe("GE-Proton10-1");
  });

  it("compatTool-wechsel rechnet usedBy der tools neu", () => {
    const store = useScanStore();
    store.result = fakeResult();
    store.result.compatToolsInstalled = [
      {
        name: "GE-Proton9-27",
        internalName: "GE-Proton9-27",
        displayName: "GE-Proton9-27",
        sizeBytes: 0,
        usedBy: [42],
        source: "user",
      },
      {
        name: "GE-Proton10-1",
        internalName: "GE-Proton10-1",
        displayName: "GE-Proton10-1",
        sizeBytes: 0,
        usedBy: [],
        source: "user",
      },
    ];

    store.applyGameConfig(42, { compatTool: "GE-Proton10-1" });

    expect(store.result.games[0]?.compatTool).toBe("GE-Proton10-1");
    expect(store.result.compatToolsInstalled[0]?.usedBy).toEqual([]);
    expect(store.result.compatToolsInstalled[1]?.usedBy).toEqual([42]);
  });

  it("mapping-entfernen (default) nimmt das spiel aus usedBy", () => {
    const store = useScanStore();
    store.result = fakeResult();
    store.result.compatToolsInstalled = [
      {
        name: "GE-Proton9-27",
        internalName: "GE-Proton9-27",
        displayName: "GE-Proton9-27",
        sizeBytes: 0,
        usedBy: [42],
        source: "user",
      },
    ];

    store.applyGameConfig(42, { compatTool: "default" });

    expect(store.result.compatToolsInstalled[0]?.usedBy).toEqual([]);
  });

  it("unbekannte appId: kein throw, kein write", () => {
    const store = useScanStore();
    store.result = fakeResult();

    expect(() => store.applyGameConfig(999, { compatTool: "x" })).not.toThrow();
    expect(store.result.games[0]?.compatTool).toBe("default");
  });

  it("ohne scan-ergebnis: kein throw", () => {
    const store = useScanStore();
    expect(() => store.applyGameConfig(42, { compatTool: "x" })).not.toThrow();
  });
});
