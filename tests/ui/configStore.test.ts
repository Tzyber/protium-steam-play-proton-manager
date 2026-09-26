import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "../../src/core/types";
import { setLocale, t } from "../../src/ui/i18n";

// mocks: tauri-adapter system ports
vi.mock("../../src/core/adapters/tauri", async () => {
  const tauriPorts = {
    fs: {},
    http: {},
    system: {
      saveLaunchOptions: vi.fn(async () => "written" as const),
      saveCompatTool: vi.fn(async () => "written" as const),
    },
    cache: {},
  };
  return {
    tauriPorts,
    appCacheDir: async () => "/tmp/protium-cache",
    logDiagnostic: vi.fn(async () => {}),
  };
});

import { logDiagnostic } from "../../src/core/adapters/tauri";
import { parseError } from "../../src/core/errtext";
import { formatError } from "../../src/ui/formatError";
import { useConfigStore } from "../../src/ui/stores/configStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { game, scanResult } from "../support/factories";

function fakeScanResult(): ScanResult {
  return scanResult({
    games: [
      game({
        appId: 730,
        name: "Test",
        sizeBytes: 0,
        compatTool: "OldTool",
        compatToolSource: "explicit",
        protonDb: { tier: "unknown", confidence: "unknown" },
      }),
    ],
    // bewusst != "default", regressionstest für Befund 1
    defaultCompatTool: "proton-cachyos-slr",
    steamUserId: "12345",
  });
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
    setLocale("de"); // fehlertexte sind jetzt lokalisiert (i18n)
    const config = useConfigStore();
    await expect(config.saveCompatTool(1, "x")).rejects.toThrow(/kein scan/);
  });

  it("wirft lokalisiert, wenn kein steam-account vorliegt", async () => {
    setLocale("de"); // fehlertexte sind jetzt lokalisiert (i18n)
    const scanStore = useScanStore();
    scanStore.result = { ...fakeScanResult(), steamUserId: null };
    const config = useConfigStore();

    await expect(config.saveLaunchOptions(730, "x")).rejects.toThrow("kein steam-account");
  });

  it("codiert und protokolliert den absichtsfehler statt ihn zu verschlucken (N-3)", async () => {
    setLocale("de");
    const config = useConfigStore();

    const error: unknown = await config.saveCompatTool(1, "x").then(
      () => null,
      (e: unknown) => e,
    );

    // code bleibt am fehler, die anzeige bekommt den gepflegten text
    // (nicht "unbekannt") und der fall landet im protokoll.
    expect(parseError(error).code).toBe("no-scan-result");
    expect(formatError(error)).toBe(t("errors.noScanResult"));
    expect(logDiagnostic).toHaveBeenCalled();
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

  it("verwirft den wert, wenn zwischenzeitlich neu gescannt wurde (N6)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    const config = useConfigStore();
    const { tauriPorts } = await import("../../src/core/adapters/tauri");

    // der write läuft noch, als der rescan den snapshot ersetzt
    vi.mocked(tauriPorts.system.saveLaunchOptions).mockImplementationOnce(async () => {
      scanStore.result = scanResult({
        games: [game({ appId: 730, launchOptions: "frischer-wert" })],
        steamUserId: "12345",
      });
      scanStore.scanGeneration += 1;
      return "written";
    });

    const r = await config.saveLaunchOptions(730, "gamemoderun %command%");

    expect(r).toBe("written");
    // der neue snapshot darf die änderung aus dem alten environment nicht zeigen
    expect(scanStore.result?.games[0]?.launchOptions).toBe("frischer-wert");
  });

  it("wendet den wert bei unverändertem snapshot weiterhin an", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    const config = useConfigStore();

    await config.saveCompatTool(730, "GE-Proton9-27");

    expect(scanStore.result?.games[0]?.compatTool).toBe("GE-Proton9-27");
  });
});
