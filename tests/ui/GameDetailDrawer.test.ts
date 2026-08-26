// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtonCheck } from "../../src/core/protoncheck";
import type { ScanResult } from "../../src/core/types";

const { scanState, uiState, configState } = vi.hoisted(() => ({
  scanState: {
    result: null as ScanResult | null,
    protonChecks: [] as ProtonCheck[],
  },
  uiState: {
    selectedAppId: 42 as number | null,
    inertMain: false,
    closeGame: vi.fn(),
    showNotification: vi.fn(),
  },
  configState: {
    saveLaunchOptions: vi.fn(async () => ({ changed: false })),
    saveCompatTool: vi.fn(async () => ({ changed: false })),
  },
}));

vi.mock("../../src/core/adapters/tauri", () => ({
  openExternal: vi.fn(async () => {}),
}));
vi.mock("../../src/ui/stores/scanStore", () => ({
  useScanStore: () => scanState,
}));
vi.mock("../../src/ui/stores/uiStore", () => ({
  useUiStore: () => uiState,
}));
vi.mock("../../src/ui/stores/configStore", () => ({
  useConfigStore: () => configState,
}));
vi.mock("../../src/ui/useCover", () => ({
  useCover: () => ({ src: null, onError: vi.fn() }),
}));
vi.mock("../../src/ui/components/PlayButton.vue", () => ({
  default: { template: '<button data-testid="play-button" />' },
}));
vi.mock("../../src/ui/components/SelectBox.vue", () => ({
  default: {
    props: ["options"],
    template:
      '<ul data-testid="select-box"><li v-for="option in options" :key="option.value" class="select-option">{{ option.label }}</li></ul>',
  },
}));
vi.mock("../../src/ui/components/TierBadge.vue", () => ({
  default: { template: '<span data-testid="tier-badge" />' },
}));

import GameDetailDrawer from "../../src/ui/components/GameDetailDrawer.vue";
import { setLocale, t } from "../../src/ui/i18n";

function result(
  compatConfigStatus: ScanResult["compatConfigStatus"],
  compatToolSource: ScanResult["games"][number]["compatToolSource"],
  compatTool: string,
  defaultCompatTool: string | null,
): ScanResult {
  return {
    steamRoot: "/home/u/.steam",
    libraries: ["/home/u/.steam"],
    games: [
      {
        appId: 42,
        name: "Game 42",
        library: "/home/u/.steam",
        sizeBytes: 100,
        compatTool,
        compatToolSource,
        protonDb: { tier: "gold", confidence: "strong" },
        localHeader: null,
        headerImage: null,
      },
    ],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool,
    compatConfigStatus,
    launchConfigStatus: "available",
    manifestCounts: { read: 0, failed: 0 },
    compatToolCounts: { read: 0, failed: 0 },
    steamUserId: null,
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
  };
}

function mountDrawer(scanResult: ScanResult, reasons: ProtonCheck["reasons"] = []) {
  scanState.result = scanResult;
  scanState.protonChecks = [{ appId: 42, reasons }];
  return mount(GameDetailDrawer, { global: { stubs: { Teleport: true } } });
}

describe("GameDetailDrawer Config-Provenienz", () => {
  beforeEach(() => {
    setLocale("de");
    uiState.selectedAppId = 42;
    uiState.inertMain = false;
    scanState.result = null;
    scanState.protonChecks = [];
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setLocale("en");
  });

  it.each([
    {
      label: "explizit",
      scan: result("available", "explicit", "missing-tool", null),
      reasons: ["tool-not-recognized"] as ProtonCheck["reasons"],
      key: "drawer.compatProvenanceExplicit" as const,
      params: { name: "missing-tool" } as Record<string, string>,
      note: true,
    },
    {
      label: "globaler default",
      scan: result("available", "default", "default", "proton_experimental"),
      reasons: [],
      key: "drawer.compatProvenanceDefault" as const,
      params: { name: "proton_experimental" } as Record<string, string>,
      note: false,
    },
    {
      label: "kein globaler default",
      scan: result("available", "unavailable", "default", null),
      reasons: [],
      key: "drawer.compatProvenanceNoDefault" as const,
      params: {} as Record<string, string>,
      note: false,
    },
    {
      label: "fehlende config",
      scan: result("missing", "unavailable", "unknown", null),
      reasons: [],
      key: "drawer.compatProvenanceMissing" as const,
      params: {} as Record<string, string>,
      note: false,
    },
    {
      label: "unlesbare config",
      scan: result("unreadable", "unavailable", "unknown", null),
      reasons: [],
      key: "drawer.compatProvenanceUnreadable" as const,
      params: {} as Record<string, string>,
      note: false,
    },
  ])(
    "zeigt den $label-text und die Erkennung nur bei explizitem Tool",
    ({ scan, reasons, key, params, note }) => {
      const wrapper = mountDrawer(scan, reasons);
      const provenance = wrapper.find("[data-testid='compat-provenance']");
      const unrecognized = wrapper.find("[data-testid='compat-unrecognized']");

      expect(provenance.text()).toBe(t(key, params));
      expect(unrecognized.exists()).toBe(note);
    },
  );

  it("markiert einen bekannten custom-tool-verzeichnisnamen nicht als unbekannt", () => {
    const scan = result("available", "explicit", "directory-tool", null);
    scan.compatToolsInstalled = [
      {
        name: "directory-tool",
        internalName: "internal-tool",
        displayName: "Directory Tool",
        sizeBytes: 0,
        usedBy: [],
        source: "user",
      },
    ];

    const wrapper = mountDrawer(scan);

    expect(wrapper.findAll(".select-option").map((option) => option.text())).toContain(
      "Directory Tool",
    );
    expect(wrapper.text()).not.toContain(t("drawer.notRecognized", { name: "directory-tool" }));
    expect(wrapper.find("[data-testid='compat-unrecognized']").exists()).toBe(false);
  });
});
