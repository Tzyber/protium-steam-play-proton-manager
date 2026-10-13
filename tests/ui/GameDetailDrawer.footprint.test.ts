// @vitest-environment happy-dom

// T-08: die mock-preamble muss vor jedem src-/store-import geladen werden.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor den modul-importen laufen (T-08)
import {
  footprint,
  measureGameFootprintMock,
  mountDrawer,
  resetDrawerMocks,
  result,
  scanState,
  uiState,
} from "./GameDetailDrawer.preamble";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GameFootprint } from "../../src/core/footprint";
import { tauriPorts } from "../../src/core/adapters/tauri";
import { setLocale, t } from "../../src/ui/i18n";
import { deferred } from "../support/factories";

describe("GameDetailDrawer Speicherbedarf", () => {
  beforeEach(() => {
    resetDrawerMocks();
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
    expect(section.find("[data-testid='footprint-measure']").text()).toBe(
      t("drawer.footprintMeasure"),
    );
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

  it("rendert fehlend als kein ordner und failed als nicht messbar", async () => {
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

    expect(wrapper.find("[data-testid='footprint-game-install-value']").text()).toBe(
      t("drawer.footprintMissing"),
    );
    expect(wrapper.find("[data-testid='footprint-compatdata-value']").text()).toBe(
      t("drawer.footprintFailed"),
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
      t("drawer.footprintFailed"),
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

  it("verwirft eine fertige Messung bei einem Rescan mit identischen Spielwerten", async () => {
    measureGameFootprintMock.mockResolvedValueOnce(
      footprint({ summary: { status: "complete", sizeBytes: 111 } }),
    );
    const wrapper = mountDrawer(result("available", "default", "default", null));

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find("[data-testid='footprint-summary']").text()).toContain("111 B");

    scanState.status = "scanning";
    scanState.scanGeneration = 2;
    await wrapper.vm.$nextTick();
    scanState.result = result("available", "default", "default", null);
    scanState.status = "done";
    await wrapper.vm.$nextTick();

    expect(wrapper.find("[data-testid='footprint-summary']").exists()).toBe(false);
  });

  it("verwirft eine deferred Messung bei einem Rescan mit identischen Spielwerten", async () => {
    const pending = deferred<GameFootprint>();
    measureGameFootprintMock.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(result("available", "default", "default", null));

    await wrapper.find("[data-testid='footprint-measure']").trigger("click");
    await wrapper.vm.$nextTick();
    scanState.status = "scanning";
    scanState.scanGeneration = 2;
    await wrapper.vm.$nextTick();
    scanState.result = result("available", "default", "default", null);
    scanState.status = "done";
    await wrapper.vm.$nextTick();

    pending.resolve(footprint({ summary: { status: "complete", sizeBytes: 111 } }));
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).not.toContain("111 B");
    expect(wrapper.find("[data-testid='footprint-summary']").exists()).toBe(false);
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
