// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import type { FootprintPart, GameFootprint } from "../../src/core/footprint";
import type { ProtonCheck } from "../../src/core/protoncheck";
import type { ScanResult } from "../../src/core/types";

const {
  scanState: rawScanState,
  uiState: rawUiState,
  configState,
  measureGameFootprintMock,
} = vi.hoisted(() => ({
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
  measureGameFootprintMock: vi.fn(),
}));
const scanState = reactive(rawScanState);
const uiState = reactive(rawUiState);

vi.mock("../../src/core/adapters/tauri", () => ({
  openExternal: vi.fn(async () => {}),
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

import { tauriPorts } from "../../src/core/adapters/tauri";
import GameDetailDrawer from "../../src/ui/components/GameDetailDrawer.vue";
import { setLocale, t } from "../../src/ui/i18n";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function footprint(
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

function result(
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
  return {
    steamRoot: "/home/u/.steam",
    libraries: ["/home/u/.steam"],
    games: [
      {
        appId,
        name: `Game ${appId}`,
        library: options.library ?? "/home/u/.steam",
        sizeBytes: 100,
        installdir: options.installdir ?? `game-${appId}`,
        compatTool,
        compatToolSource,
        protonDb: { tier: "gold", confidence: "strong" },
        localHeader: null,
        headerImage: null,
        launchOptions: options.launchOptions,
      },
    ],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool,
    compatConfigStatus,
    launchConfigStatus: options.launchConfigStatus ?? "available",
    manifestCounts: { read: 0, failed: 0 },
    compatToolCounts: { read: 0, failed: 0 },
    steamUserId: null,
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
    blockedAppIds: [],
  };
}

function mountDrawer(scanResult: ScanResult, reasons: ProtonCheck["reasons"] = []) {
  scanState.result = scanResult;
  scanState.protonChecks = [{ appId: scanResult.games[0]?.appId ?? 42, reasons }];
  return mount(GameDetailDrawer, { global: { stubs: { Teleport: true } } });
}

describe("GameDetailDrawer Config-Provenienz", () => {
  beforeEach(() => {
    setLocale("de");
    uiState.selectedAppId = 42;
    uiState.inertMain = false;
    scanState.result = null;
    scanState.protonChecks = [];
    measureGameFootprintMock.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setLocale("en");
  });

  it("zeigt die appid in der metazeile mit einem leerzeichen", () => {
    uiState.selectedAppId = 620;
    const wrapper = mountDrawer(result("available", "default", "default", null, { appId: 620 }));

    expect(wrapper.get(".meta").text()).toBe("100 B · appid - 620");
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

describe("GameDetailDrawer Speicherbedarf", () => {
  beforeEach(() => {
    setLocale("de");
    uiState.selectedAppId = 42;
    uiState.inertMain = false;
    scanState.result = null;
    scanState.protonChecks = [];
    measureGameFootprintMock.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setLocale("en");
  });

  it("zeigt den Messbutton nach den Metadaten und vor der Konfiguration", () => {
    const wrapper = mountDrawer(result("available", "default", "default", null));

    const section = wrapper.find("[data-testid='footprint-section']");
    expect(section.exists()).toBe(true);
    expect(section.find("h3").text()).toBe(t("drawer.footprintTitle"));
    expect(section.find("button").text()).toBe(t("drawer.footprintMeasure"));
    expect(wrapper.find(".meta-tier").element.compareDocumentPosition(section.element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      section.element.compareDocumentPosition(
        wrapper.find("[data-testid='compat-provenance']").element,
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("ruft beim Button exakt die Messung mit tauriPorts.system und Launch-Status auf", async () => {
    const measured = footprint();
    measureGameFootprintMock.mockResolvedValueOnce(measured);
    const current = result("available", "default", "default", null);
    const wrapper = mountDrawer(current);

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();

    expect(measureGameFootprintMock).toHaveBeenCalledTimes(1);
    expect(measureGameFootprintMock).toHaveBeenCalledWith(
      tauriPorts.system,
      current.games[0],
      current.launchConfigStatus,
    );
  });

  it("zeigt aria-busy und einen sichtbaren Ladezustand pro Teilwert", async () => {
    const pending = deferred<GameFootprint>();
    measureGameFootprintMock.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(result("available", "default", "default", null));

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();

    const section = wrapper.find("[data-testid='footprint-section']");
    expect(section.attributes("aria-busy")).toBe("true");
    for (const part of ["game-install", "compatdata", "shadercache"]) {
      expect(section.find(`[data-testid='footprint-${part}-value']`).text()).toBe(
        t("drawer.footprintLoading"),
      );
    }

    pending.resolve(footprint());
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(section.attributes("aria-busy")).toBe("false");
  });

  it("rendert fehlend als exakt 0 B und failed als nicht gemessen", async () => {
    measureGameFootprintMock.mockResolvedValueOnce(
      footprint({
        gameInstall: { status: "missing", sizeBytes: 0 },
        compatdata: { status: "failed" },
        summary: { status: "partial", sizeBytes: 30 },
      }),
    );
    const wrapper = mountDrawer(result("available", "default", "default", null));

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find("[data-testid='footprint-game-install-value']").text()).toBe("0 B");
    expect(wrapper.find("[data-testid='footprint-compatdata-value']").text()).toBe(
      t("common.notMeasured"),
    );
  });

  it("rendert direkt gemessenes sizeBytes 0 als exakt 0 B", async () => {
    measureGameFootprintMock.mockResolvedValueOnce(
      footprint({
        gameInstall: { status: "measured", sizeBytes: 0 },
        summary: { status: "complete", sizeBytes: 50 },
      }),
    );
    const wrapper = mountDrawer(result("available", "default", "default", null));

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find("[data-testid='footprint-game-install-value']").text()).toBe("0 B");
  });

  it("kennzeichnet partial und not-measured textklar", async () => {
    measureGameFootprintMock.mockResolvedValueOnce(
      footprint({
        gameInstall: { status: "failed" },
        compatdata: { status: "not-requested" },
        shadercache: { status: "measured", sizeBytes: 30 },
        summary: { status: "partial", sizeBytes: 30 },
      }),
    );
    const wrapper = mountDrawer(result("available", "default", "default", null));

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find("[data-testid='footprint-summary']").text()).toContain(
      t("drawer.footprintSummaryPartial"),
    );
    expect(wrapper.find("[data-testid='footprint-game-install-value']").text()).toBe(
      t("common.notMeasured"),
    );

    measureGameFootprintMock.mockResolvedValueOnce(
      footprint({
        gameInstall: { status: "failed" },
        compatdata: { status: "failed" },
        shadercache: { status: "failed" },
        summary: { status: "not-measured" },
      }),
    );
    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find("[data-testid='footprint-summary']").text()).toBe(t("common.notMeasured"));
  });

  it.each([
    {
      locale: "de" as const,
      complete: "bekannt belegt",
      partial: "bekannt belegt (teilweise)",
    },
    {
      locale: "en" as const,
      complete: "known footprint",
      partial: "known footprint (partial)",
    },
  ])(
    "zeigt den vollständigkeitsstatus korrekt in $locale",
    async ({ locale, complete, partial }) => {
      setLocale(locale);
      measureGameFootprintMock.mockResolvedValueOnce(
        footprint({ summary: { status: "complete", sizeBytes: 60 } }),
      );
      const wrapper = mountDrawer(result("available", "default", "default", null));

      await wrapper.find("[data-testid='footprint-measure']").trigger("click");
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();
      expect(wrapper.find("[data-testid='footprint-summary'] .k").text()).toBe(complete);

      measureGameFootprintMock.mockResolvedValueOnce(
        footprint({ summary: { status: "partial", sizeBytes: 30 } }),
      );
      await wrapper.find("[data-testid='footprint-measure']").trigger("click");
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();
      expect(wrapper.find("[data-testid='footprint-summary'] .k").text()).toBe(partial);
    },
  );

  it.each([
    {
      locale: "de" as const,
      title: "speicherbedarf",
      measure: "speicherbedarf messen",
      game: "spieldateien",
    },
    {
      locale: "en" as const,
      title: "known footprint",
      measure: "measure storage footprint",
      game: "game files",
    },
  ])("zeigt alle Footprint-Texte in $locale", async ({ locale, title, measure, game }) => {
    setLocale(locale);
    measureGameFootprintMock.mockResolvedValueOnce(footprint());
    const wrapper = mountDrawer(result("available", "default", "default", null));

    expect(wrapper.find("[data-testid='footprint-section'] h3").text()).toBe(title);
    expect(wrapper.find("[data-testid='footprint-measure']").text()).toBe(measure);

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find("[data-testid='footprint-game-install'] .k").text()).toBe(game);
    expect(wrapper.find("[data-testid='footprint-summary']").exists()).toBe(true);
  });

  it("zeigt den externen Hinweis nur bei externalCompatdata", async () => {
    measureGameFootprintMock.mockResolvedValueOnce(
      footprint({
        compatdata: { status: "not-requested" },
        summary: { status: "partial", sizeBytes: 40 },
        externalCompatdata: true,
      }),
    );
    const wrapper = mountDrawer(
      result("available", "default", "default", null, {
        launchOptions: "STEAM_COMPAT_DATA_PATH=/secret/user/prefix",
      }),
    );

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find("[data-testid='footprint-external-compatdata']").text()).toBe(
      t("drawer.footprintExternalCompatdata"),
    );
    expect(wrapper.text()).not.toContain("/secret/user/prefix");
    expect(wrapper.find("[data-testid='footprint-compatdata-not-checked']").exists()).toBe(false);
  });

  it("zeigt den neutralen nicht-geprüft-hinweis nur bei compatdataNotChecked", async () => {
    measureGameFootprintMock.mockResolvedValueOnce(
      footprint({
        compatdata: { status: "not-requested" },
        summary: { status: "partial", sizeBytes: 40 },
        compatdataNotChecked: true,
      }),
    );
    const wrapper = mountDrawer(
      result("available", "default", "default", null, {
        launchConfigStatus: "ambiguous",
        launchOptions: "STEAM_COMPAT_DATA_PATH=/secret/user/prefix",
      }),
    );

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find("[data-testid='footprint-compatdata-not-checked']").text()).toBe(
      t("drawer.footprintCompatdataNotChecked"),
    );
    expect(wrapper.find("[data-testid='footprint-external-compatdata']").exists()).toBe(false);
  });

  it.each(["missing", "unreadable", "ambiguous"] as const)(
    "übergibt bei LaunchConfigStatus %s den Status und zeigt nur den neutralen Hinweis",
    async (launchConfigStatus) => {
      const measured = footprint({
        compatdata: { status: "not-requested" },
        summary: { status: "partial", sizeBytes: 40 },
        externalCompatdata: false,
        compatdataNotChecked: true,
      });
      measureGameFootprintMock.mockResolvedValueOnce(measured);
      const current = result("available", "default", "default", null, {
        launchConfigStatus,
        launchOptions: "STEAM_COMPAT_DATA_PATH=/secret/user/prefix",
      });
      const wrapper = mountDrawer(current);

      await wrapper.find("[data-testid='footprint-measure']").trigger("click");
      await wrapper.vm.$nextTick();
      await wrapper.vm.$nextTick();

      expect(measureGameFootprintMock).toHaveBeenCalledTimes(1);
      expect(measureGameFootprintMock).toHaveBeenCalledWith(
        tauriPorts.system,
        current.games[0],
        launchConfigStatus,
      );
      expect(wrapper.find("[data-testid='footprint-compatdata-not-checked']").text()).toBe(
        t("drawer.footprintCompatdataNotChecked"),
      );
      expect(wrapper.find("[data-testid='footprint-external-compatdata']").exists()).toBe(false);
      expect(wrapper.text()).not.toContain(t("drawer.footprintExternalCompatdata"));
    },
  );

  it("verwirft eine alte Auflösung nach schließen und erneutem Öffnen derselben AppID", async () => {
    const first = deferred<GameFootprint>();
    const second = deferred<GameFootprint>();
    measureGameFootprintMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const wrapper = mountDrawer(result("available", "default", "default", null));

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    uiState.selectedAppId = null;
    await wrapper.vm.$nextTick();
    uiState.selectedAppId = 42;
    await wrapper.vm.$nextTick();
    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();

    first.resolve(footprint({ summary: { status: "complete", sizeBytes: 111 } }));
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find("[data-testid='footprint-summary']").text()).toContain(
      t("drawer.footprintLoading"),
    );

    second.resolve(footprint({ summary: { status: "complete", sizeBytes: 222 } }));
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find("[data-testid='footprint-summary']").text()).toContain("222 B");
    expect(wrapper.find("[data-testid='footprint-summary']").text()).not.toContain("111 B");
  });

  it("verwirft die Antwort nach einem Spielwechsel", async () => {
    const pending = deferred<GameFootprint>();
    measureGameFootprintMock.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(result("available", "default", "default", null));

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    scanState.result = result("available", "default", "default", null, { appId: 43 });
    uiState.selectedAppId = 43;
    await wrapper.vm.$nextTick();
    pending.resolve(footprint({ summary: { status: "complete", sizeBytes: 111 } }));
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).not.toContain("111 B");
    expect(wrapper.find("[data-testid='footprint-measure']").exists()).toBe(true);
  });

  it.each([
    { label: "library", options: { library: "/mnt/secondary" } },
    { label: "installdir", options: { installdir: "changed-dir" } },
    {
      label: "compatdata-entscheidung durch LaunchConfigStatus",
      options: { launchConfigStatus: "ambiguous" as const },
    },
    {
      label: "compatdata-entscheidung durch LaunchOptions",
      options: { launchOptions: "STEAM_COMPAT_DATA_PATH=/secret/user/prefix" },
    },
  ])("verwirft die alte Antwort nach einzeln geänderter $label", async ({ options }) => {
    const pending = deferred<GameFootprint>();
    measureGameFootprintMock.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(result("available", "default", "default", null));

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    scanState.result = result("available", "default", "default", null, options);
    await wrapper.vm.$nextTick();
    pending.resolve(footprint({ summary: { status: "complete", sizeBytes: 111 } }));
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).not.toContain("111 B");
    expect(wrapper.find("[data-testid='footprint-summary']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='footprint-measure']").exists()).toBe(true);
  });

  it("akzeptiert bei zwei Läufen derselben AppID nur die jüngste Antwort", async () => {
    const first = deferred<GameFootprint>();
    const second = deferred<GameFootprint>();
    measureGameFootprintMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const wrapper = mountDrawer(result("available", "default", "default", null));

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    uiState.selectedAppId = null;
    await wrapper.vm.$nextTick();
    uiState.selectedAppId = 42;
    await wrapper.vm.$nextTick();
    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();

    second.resolve(footprint({ summary: { status: "complete", sizeBytes: 222 } }));
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    first.resolve(footprint({ summary: { status: "complete", sizeBytes: 111 } }));
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find("[data-testid='footprint-summary']").text()).toContain("222 B");
    expect(wrapper.find("[data-testid='footprint-summary']").text()).not.toContain("111 B");
  });
});
