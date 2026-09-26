// T-08: gemeinsame mock-preamble, reaktive store-stubs und helfer der
// GameDetailDrawer-Tests. MUSS vor den Komponenten-/Store-Importen geladen
// werden (wie tests/support/cleanupStoreMocks.ts), sonst greifen die vi.mock-
// Aufrufe zu spät.
import { mount } from "@vue/test-utils";
import { vi } from "vitest";
import { reactive } from "vue";
import type { FootprintPart, GameFootprint } from "../../src/core/footprint";
import type { WriteResult } from "../../src/core/ports";
import type { ProtonCheck } from "../../src/core/protoncheck";
import type { ScanResult } from "../../src/core/types";

const {
  scanState: rawScanState,
  uiState: rawUiState,
  configState,
  cleanupState: rawCleanupState,
  measureGameFootprintMock,
} = vi.hoisted(() => ({
  scanState: {
    result: null as ScanResult | null,
    protonChecks: [] as ProtonCheck[],
    status: "done" as "idle" | "scanning" | "done" | "not-found" | "error",
    scanGeneration: 1,
  },
  uiState: {
    selectedAppId: 42 as number | null,
    inertMain: false,
    explanationCount: 0,
    closeGame: vi.fn(),
    showNotification: vi.fn(),
    openExplanation: vi.fn(),
    closeExplanation: vi.fn(),
  },
  configState: {
    saveLaunchOptions: vi.fn(async (): Promise<WriteResult> => "unchanged"),
    saveCompatTool: vi.fn(async (): Promise<WriteResult> => "unchanged"),
  },
  cleanupState: {
    scanning: false,
    trashScanning: false,
    prefixUnavailable: false,
    shaderUnavailable: false,
    trashUnavailable: false,
    incompleteDeletions: [] as { type: string }[],
    incompleteDeletionsUnreadable: [] as string[],
  },
  measureGameFootprintMock: vi.fn(),
}));
const scanState = reactive(rawScanState);
const uiState = reactive(rawUiState);
const cleanupState = reactive(rawCleanupState);

vi.mock("../../src/core/adapters/tauri", () => ({
  openExternal: vi.fn(async () => {}),
  openPrefixFolder: vi.fn(async () => {}),
  tauriPorts: { system: {} },
}));
vi.mock("../../src/core/footprint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/footprint")>();
  return {
    ...actual,
    measureGameFootprint: measureGameFootprintMock,
  };
});
vi.mock("../../src/ui/stores/scanStore", () => ({
  useScanStore: () => scanState,
}));
vi.mock("../../src/ui/stores/uiStore", () => ({
  useUiStore: () => uiState,
}));
vi.mock("../../src/ui/stores/configStore", () => ({
  useConfigStore: () => configState,
}));
vi.mock("../../src/ui/stores/cleanupStore", () => ({
  useCleanupStore: () => cleanupState,
}));
// async-fabriken mit dynamischem import: so liegen die stubs in einer datei,
// ohne dass hoisting von vi.mock ihre initialisierung überholen kann (N-1).
vi.mock("../../src/ui/useCover", async () => ({
  useCover: (await import("./GameDetailDrawer.stubs")).useCoverStub,
}));
vi.mock("../../src/ui/components/PlayButton.vue", async () => ({
  default: (await import("./GameDetailDrawer.stubs")).playButtonStub,
}));
vi.mock("../../src/ui/components/SelectBox.vue", async () => ({
  default: (await import("./GameDetailDrawer.stubs")).selectBoxStub,
}));
vi.mock("../../src/ui/components/TierBadge.vue", async () => ({
  default: (await import("./GameDetailDrawer.stubs")).tierBadgeStub,
}));

import GameDetailDrawer from "../../src/ui/components/GameDetailDrawer.vue";
import { game as makeGame, scanResult } from "../support/factories";
import { routeQueriesToBody } from "./drawerDom";

/** Pflicht-Element aus dem DOM: ein fehlendes Element lässt den Test mit
 *  klarer Meldung scheitern statt still zurückzuspringen. */
export function requireElement(selector: string, root: ParentNode = document): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`element nicht gefunden: ${selector}`);
  return element;
}

export function footprint(
  overrides: {
    gameInstall?: FootprintPart;
    compatdata?: FootprintPart;
    shadercache?: FootprintPart;
    summary?: GameFootprint["summary"];
    externalCompatdata?: boolean;
    compatdataNotChecked?: boolean;
  } = {},
): GameFootprint {
  return {
    gameInstall: overrides.gameInstall ?? { status: "measured", sizeBytes: 10 },
    compatdata: overrides.compatdata ?? { status: "measured", sizeBytes: 20 },
    shadercache: overrides.shadercache ?? { status: "measured", sizeBytes: 30 },
    summary: overrides.summary ?? { status: "complete", sizeBytes: 60 },
    externalCompatdata: overrides.externalCompatdata ?? false,
    compatdataNotChecked: overrides.compatdataNotChecked ?? false,
  };
}

export function result(
  compatConfigStatus: ScanResult["compatConfigStatus"],
  compatToolSource: ScanResult["games"][number]["compatToolSource"],
  compatTool: string,
  defaultCompatTool: string | null,
  options: {
    appId?: number;
    library?: string;
    installdir?: string;
    launchOptions?: string;
    launchConfigStatus?: ScanResult["launchConfigStatus"];
  } = {},
): ScanResult {
  const appId = options.appId ?? 42;
  return scanResult({
    games: [
      makeGame({
        appId,
        library: options.library ?? "/home/u/.steam",
        installdir: options.installdir ?? `game-${appId}`,
        compatTool,
        compatToolSource,
        protonDb: { tier: "gold", confidence: "strong" },
        launchOptions: options.launchOptions,
      }),
    ],
    defaultCompatTool,
    compatConfigStatus,
    launchConfigStatus: options.launchConfigStatus ?? "available",
  });
}

export function mountDrawer(scanResult: ScanResult, reasons: ProtonCheck["reasons"] = []) {
  scanState.result = scanResult;
  scanState.protonChecks = [{ appId: scanResult.games[0]?.appId ?? 42, reasons }];
  const wrapper = mount(GameDetailDrawer, { attachTo: document.body });
  routeQueriesToBody(wrapper);
  return wrapper;
}

export { cleanupState, configState, measureGameFootprintMock, scanState, uiState };
