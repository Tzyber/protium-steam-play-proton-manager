import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "../../src/core/types";

// mocks: compatwrite-core + appCacheDir (tauri-adapter)
vi.mock("../../src/core/compatwrite", () => ({
  writeCompatTool: vi.fn(async () => "written" as const),
  removeCompatTool: vi.fn(async () => "written" as const),
}));
vi.mock("../../src/core/localconfig", () => ({
  writeLaunchOptions: vi.fn(async () => "written" as const),
}));
vi.mock("../../src/core/adapters/tauri", async () => {
  const tauriPorts = { fs: {}, http: {}, system: {}, cache: {} };
  return { tauriPorts, appCacheDir: async () => "/tmp/protium-cache" };
});

import { useConfigStore } from "../../src/ui/stores/configStore";
import { useScanStore } from "../../src/ui/stores/scanStore";

function fakeScanResult(): ScanResult {
  return {
    steamRoot: "/home/u/.steam",
    libraries: ["/home/u/.steam"],
    games: [
      {
        appId: 730,
        name: "Test",
        library: "/home/u/.steam",
        sizeBytes: 0,
        compatTool: "OldTool",
        protonDb: { tier: "unknown", confidence: "unknown" },
        localHeader: null,
        headerImage: null,
      },
    ],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: "proton-cachyos-slr", // bewusst != "default", regressionstest für Befund 1
    steamUserId: "12345",
    warnings: [],
    skippedLibraries: [],
  };
}

describe("configStore.saveCompatTool", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("null (= standard) setzt game.compatTool auf 'default', NICHT auf defaultCompatTool", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    const config = useConfigStore();

    const r = await config.saveCompatTool(730, null);

    expect(r).toBe("written");
    const game = scanStore.result?.games[0];
    expect(game?.compatTool).toBe("default"); // nicht "proton-cachyos-slr"
  });

  it("specific tool setzt game.compatTool auf den internen namen", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    const config = useConfigStore();

    const r = await config.saveCompatTool(730, "GE-Proton9-27");

    expect(r).toBe("written");
    const game = scanStore.result?.games[0];
    expect(game?.compatTool).toBe("GE-Proton9-27");
  });

  it("wirft weiter, wenn kein scan vorliegt", async () => {
    const config = useConfigStore();
    await expect(config.saveCompatTool(1, "x")).rejects.toThrow(/kein scan/);
  });
});

describe("scanStore.applyGameConfig", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("setzt launchOptions am spiel im scanStore", () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();

    scanStore.applyGameConfig(730, { launchOptions: "PROTON_USE_WINED3D=1 %command%" });

    const game = scanStore.result?.games[0];
    expect(game?.launchOptions).toBe("PROTON_USE_WINED3D=1 %command%");
  });

  it("setzt compatTool am spiel im scanStore", () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();

    scanStore.applyGameConfig(730, { compatTool: "GE-Proton9-27" });

    const game = scanStore.result?.games[0];
    expect(game?.compatTool).toBe("GE-Proton9-27");
  });

  it("ignoriert unbekannte appId still (kein throw)", () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();

    expect(() => scanStore.applyGameConfig(999999, { launchOptions: "x" })).not.toThrow();
  });

  it("setzt beide felder in einem aufruf", () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();

    scanStore.applyGameConfig(730, { launchOptions: "-dx11", compatTool: "Proton-9" });

    const game = scanStore.result?.games[0];
    expect(game?.launchOptions).toBe("-dx11");
    expect(game?.compatTool).toBe("Proton-9");
  });
});

describe("configStore.saveLaunchOptions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("schreibt via scanStore.applyGameConfig statt direkt auf result.games", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    const config = useConfigStore();

    const r = await config.saveLaunchOptions(730, "-console");

    expect(r).toBe("written");
    const game = scanStore.result?.games[0];
    expect(game?.launchOptions).toBe("-console");
  });
});
