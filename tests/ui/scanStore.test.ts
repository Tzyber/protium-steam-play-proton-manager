import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSnapshot } from "../../src/core/ports";
import type { scanLibrary } from "../../src/core/scan";
import type { ScanResult } from "../../src/core/types";
import { setLocale } from "../../src/ui/i18n";

const { mockDiscoverEnvironment, mockScanLibrary } = vi.hoisted(() => ({
  mockDiscoverEnvironment: vi.fn<() => Promise<EnvironmentSnapshot>>(async () => ({
    generation: 1,
    steamRoot: "/home/u/.steam",
    libraries: ["/home/u/.steam"],
    systemCompatDirs: [],
    appCacheDir: "/home/u/.cache/protium",
    appConfigDir: "/home/u/.config/protium",
  })),
  mockScanLibrary: vi.fn<typeof scanLibrary>(),
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
vi.mock("../../src/core/scan", () => ({
  scanLibrary: mockScanLibrary,
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
        protonDb: null,
        localHeader: null,
        headerImage: null,
      },
    ],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: null,
    steamUserId: null,
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
  };
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
    mockScanLibrary.mockReset();
  });

  it("happy path: scanning → done, result gesetzt, fehler zurückgesetzt", async () => {
    mockScanLibrary.mockResolvedValue(fakeResult());
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
    expect(mockScanLibrary).not.toHaveBeenCalled();
  });

  it("generischer fehler → status error + meldung", async () => {
    mockScanLibrary.mockRejectedValue(new Error("kaputt"));
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
