// @vitest-environment happy-dom

// T-08: die mock-preamble muss vor jedem src-/store-import geladen werden.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor den modul-importen laufen (T-08)
import {
  cleanupState,
  configState,
  footprint,
  measureGameFootprintMock,
  mountDrawer,
  result,
  scanState,
  uiState,
} from "./GameDetailDrawer.preamble";
import { DOMWrapper, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { GameFootprint } from "../../src/core/footprint";
import type { WriteResult } from "../../src/core/ports";
import type { ScanResult } from "../../src/core/types";
import { tauriPorts } from "../../src/core/adapters/tauri";
import { setLocale, t } from "../../src/ui/i18n";
import { deferred } from "../support/factories";

describe("GameDetailDrawer Speicherbedarf", () => {
  beforeEach(() => {
    setLocale("de");
    uiState.selectedAppId = 42;
    uiState.inertMain = false;
    scanState.result = null;
    scanState.protonChecks = [];
    scanState.status = "done";
    scanState.scanGeneration = 1;
    cleanupState.scanning = false;
    cleanupState.trashScanning = false;
    cleanupState.prefixUnavailable = false;
    cleanupState.shaderUnavailable = false;
    cleanupState.trashUnavailable = false;
    cleanupState.incompleteDeletions = [];
    cleanupState.incompleteDeletionsUnreadable = [];
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

describe("GameDetailDrawer Speicherstatus", () => {
  beforeEach(() => {
    setLocale("de");
    uiState.selectedAppId = 42;
    uiState.inertMain = false;
    scanState.result = null;
    scanState.protonChecks = [];
    scanState.status = "done";
    scanState.scanGeneration = 1;
    configState.saveLaunchOptions.mockReset();
    configState.saveCompatTool.mockReset();
    configState.saveLaunchOptions.mockResolvedValue("written");
    configState.saveCompatTool.mockResolvedValue("written");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setLocale("en");
  });

  function buttonNextTo(
    wrapper: ReturnType<typeof mountDrawer>,
    selector: string,
  ): DOMWrapper<HTMLButtonElement> {
    const button = wrapper.get(selector).element.parentElement?.querySelector("button");
    if (!button) throw new Error(`button next to ${selector} missing`);
    return new DOMWrapper(button);
  }

  function launchSaveButton(wrapper: ReturnType<typeof mountDrawer>) {
    return buttonNextTo(wrapper, "#launch-options");
  }

  function compatSaveButton(wrapper: ReturnType<typeof mountDrawer>) {
    return buttonNextTo(wrapper, "[data-testid='select-box']");
  }

  function compatScanResult(): ScanResult {
    const scan = result("available", "explicit", "tool-a", null, { launchOptions: "" });
    scan.compatToolsInstalled = [
      {
        name: "tool-a",
        internalName: "tool-a",
        displayName: "Tool A",
        sizeBytes: 0,
        usedBy: [],
        source: "user",
      },
      {
        name: "tool-b",
        internalName: "tool-b",
        displayName: "Tool B",
        sizeBytes: 0,
        usedBy: [],
        source: "user",
      },
    ];
    return scan;
  }

  async function selectCompatTool(
    wrapper: ReturnType<typeof mountDrawer>,
    label: string,
  ): Promise<void> {
    const option = wrapper.findAll(".select-option").find((li) => li.text() === label);
    if (!option) throw new Error(`compat option missing: ${label}`);
    await option.trigger("click");
  }

  function switchToGame43(): void {
    scanState.result = result("available", "default", "default", null, {
      appId: 43,
      launchOptions: "",
    });
    uiState.selectedAppId = 43;
  }

  it("zeigt nach einem geschriebenen Startoptionen-Save den gespeichert-Status", async () => {
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("  gamemoderun %command%  ");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    expect(configState.saveLaunchOptions).toHaveBeenCalledExactlyOnceWith(
      42,
      "gamemoderun %command%",
    );
    expect(launchSaveButton(wrapper).text()).toBe(t("drawer.saved"));
  });

  it("zeigt bei unchanged kein gespeichert ✓ für die Startoptionen", async () => {
    configState.saveLaunchOptions.mockResolvedValue("unchanged");
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    expect(configState.saveLaunchOptions).toHaveBeenCalledTimes(1);
    expect(launchSaveButton(wrapper).text()).not.toBe(t("drawer.saved"));
    expect(launchSaveButton(wrapper).text()).toBe(t("drawer.save"));
  });

  it("nennt bei write-may-have-applied nicht 'nichts verändert' (Review A)", async () => {
    // Nach dem Rename ist der Abschluss offen; die Ablehnungsansicht darf dann
    // nicht den Garantiesatz des sauberen Abbruchs zeigen.
    configState.saveLaunchOptions.mockRejectedValueOnce(
      "write-may-have-applied: atomic write (parent sync): injected failure",
    );
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    const blocked = wrapper.get(".blocked-explanation");
    expect(blocked.text()).toContain(t("drawer.saveUncertain"));
    expect(blocked.text()).not.toContain(t("common.nothingChanged"));
  });

  it("bleibt beim sauberen Abbruch bei 'nichts verändert'", async () => {
    configState.saveLaunchOptions.mockRejectedValueOnce("steam-running");
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    const blocked = wrapper.get(".blocked-explanation");
    expect(blocked.text()).toContain(t("common.nothingChanged"));
    expect(blocked.text()).not.toContain(t("drawer.saveUncertain"));
  });

  it("zeigt beide speicherfehler und behält den garantiesatz nur ohne unsicheren ausgang (N-4)", async () => {
    // alter fehler: nur der erste fehler war sichtbar, und der garantiesatz
    // wurde aus ihm allein bestimmt. ein unsicherer startoptionen-write plus
    // sicherer compat-fehler zeigte fälschlich „nichts wurde verändet".
    configState.saveLaunchOptions.mockRejectedValueOnce(
      "write-may-have-applied: atomic write (parent sync): injected failure",
    );
    configState.saveCompatTool.mockRejectedValueOnce("steam-running");
    const wrapper = mountDrawer(compatScanResult());

    const input = wrapper.get<HTMLInputElement>("#launch-options");
    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    const blocked = wrapper.get(".blocked-explanation");
    expect(blocked.text()).toContain(t("errors.codes.writeMayHaveApplied"));
    expect(blocked.text()).toContain(t("errors.codes.steamRunning"));
    expect(blocked.text()).not.toContain(t("common.nothingChanged"));
    expect(blocked.text()).toContain(t("drawer.saveUncertain"));
  });

  it("verwirft ein Startoptionen-Ergebnis nach Änderung des sichtbaren Werts", async () => {
    const pending = deferred<WriteResult>();
    configState.saveLaunchOptions.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await nextTick();
    expect(configState.saveLaunchOptions).toHaveBeenCalledTimes(1);

    await input.setValue("gamemoderun %command% --später");
    pending.resolve("written");
    await flushPromises();
    await nextTick();

    expect(input.element.value).toBe("gamemoderun %command% --später");
    expect(launchSaveButton(wrapper).text()).not.toBe(t("drawer.saved"));
    // der verworfene auftrag darf den knopf nicht dauerhaft sperren
    expect(launchSaveButton(wrapper).text()).toBe(t("drawer.save"));
    expect(launchSaveButton(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("beendet den ladezustand auch bei fehler plus entwurfsänderung (N-2)", async () => {
    // alter fehler: der catch-zweig kehrte bei abweichendem entwurf zurück,
    // ohne den status zu beenden; der knopf hing dauerhaft auf "…"/gesperrt.
    const pending = deferred<WriteResult>();
    configState.saveLaunchOptions.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await nextTick();
    expect(configState.saveLaunchOptions).toHaveBeenCalledTimes(1);

    // entwurf läuft weiter, während der write hängt
    await input.setValue("gamemoderun %command% --später");
    pending.reject(new Error("steam-running"));
    await flushPromises();
    await nextTick();

    expect(launchSaveButton(wrapper).text()).toBe(t("drawer.save"));
    expect(launchSaveButton(wrapper).attributes("disabled")).toBeUndefined();
    // der gescheiterte vorgang bleibt sichtbar (U-02)
    expect(wrapper.get(".blocked-explanation").text()).toContain(t("errors.codes.steamRunning"));
  });

  it("beendet den ladezustand auch bei fehler plus entwurfsänderung am compat-tool (N-2)", async () => {
    const pending = deferred<WriteResult>();
    configState.saveCompatTool.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(compatScanResult());

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await nextTick();
    expect(configState.saveCompatTool).toHaveBeenCalledTimes(1);

    await selectCompatTool(wrapper, "Tool A");
    pending.reject(new Error("steam-running"));
    await flushPromises();
    await nextTick();

    // zurück auf den ursprungswert: der entwurf ist sauber, der knopf darf nur
    // deshalb (nicht wegen eines hängenden ladezustands) gesperrt sein.
    expect(compatSaveButton(wrapper).text()).toBe(t("drawer.save"));
    expect(compatSaveButton(wrapper).attributes("disabled")).toBeDefined();

    // ein erneut geänderter entwurf muss den knopf wieder freigeben: beim
    // alten fehlerpfad blieb `saving` stehen und der knopf dauerhaft tot (N-2).
    await selectCompatTool(wrapper, "Tool B");
    await nextTick();
    expect(compatSaveButton(wrapper).attributes("disabled")).toBeUndefined();
    expect(wrapper.get(".blocked-explanation").text()).toContain(t("errors.codes.steamRunning"));
  });

  it("verwirft die Startoptionen-Antwort nach einem Spielwechsel", async () => {
    const pending = deferred<WriteResult>();
    configState.saveLaunchOptions.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await nextTick();
    expect(configState.saveLaunchOptions).toHaveBeenCalledExactlyOnceWith(
      42,
      "gamemoderun %command%",
    );

    switchToGame43();
    await nextTick();

    pending.resolve("written");
    await flushPromises();
    await nextTick();

    expect(launchSaveButton(wrapper).text()).not.toBe(t("drawer.saved"));
    expect(launchSaveButton(wrapper).text()).toBe(t("drawer.save"));
    expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
  });

  it("zeigt nach einem Spielwechsel keinen fremden Startoptionen-Fehler", async () => {
    const pending = deferred<WriteResult>();
    configState.saveLaunchOptions.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await nextTick();

    switchToGame43();
    await nextTick();

    pending.reject(new Error("fremder Fehler 934"));
    await flushPromises();
    await nextTick();

    expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("fremder Fehler 934");
  });

  it("zeigt nach einem geschriebenen Compat-Save den gespeichert-Status", async () => {
    const wrapper = mountDrawer(compatScanResult());

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    expect(configState.saveCompatTool).toHaveBeenCalledExactlyOnceWith(42, "tool-b");
    expect(compatSaveButton(wrapper).text()).toBe(t("drawer.saved"));
  });

  it("zeigt bei unchanged kein gespeichert ✓ für das Compat-Tool", async () => {
    configState.saveCompatTool.mockResolvedValue("unchanged");
    const wrapper = mountDrawer(compatScanResult());

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    expect(configState.saveCompatTool).toHaveBeenCalledTimes(1);
    expect(compatSaveButton(wrapper).text()).not.toBe(t("drawer.saved"));
    expect(compatSaveButton(wrapper).text()).toBe(t("drawer.save"));
  });

  it("verwirft die Compat-Antwort nach einem Spielwechsel", async () => {
    const pending = deferred<WriteResult>();
    configState.saveCompatTool.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(compatScanResult());

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await nextTick();
    expect(configState.saveCompatTool).toHaveBeenCalledExactlyOnceWith(42, "tool-b");

    switchToGame43();
    await nextTick();

    pending.resolve("written");
    await flushPromises();
    await nextTick();

    expect(compatSaveButton(wrapper).text()).not.toBe(t("drawer.saved"));
    expect(compatSaveButton(wrapper).text()).toBe(t("drawer.save"));
    expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
  });

  it("zeigt nach einem Spielwechsel keinen fremden Compat-Fehler", async () => {
    const pending = deferred<WriteResult>();
    configState.saveCompatTool.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(compatScanResult());

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await nextTick();

    switchToGame43();
    await nextTick();

    pending.reject(new Error("fremder Compat-Fehler 935"));
    await flushPromises();
    await nextTick();

    expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("fremder Compat-Fehler 935");
  });

  it("hält den Fehler stehen, bis der Nutzer ihn schließt (U-02)", async () => {
    vi.useFakeTimers();
    try {
      configState.saveLaunchOptions.mockRejectedValueOnce("steam-running");
      const wrapper = mountDrawer(
        result("available", "default", "default", null, { launchOptions: "" }),
      );
      const input = wrapper.get<HTMLInputElement>("#launch-options");

      await input.setValue("gamemoderun %command%");
      await launchSaveButton(wrapper).trigger("click");
      await vi.advanceTimersByTimeAsync(7000);
      await nextTick();

      // kein auto-hide mehr: der block überlebt die frühere 6-s-grenze
      expect(wrapper.get(".blocked-explanation").text()).toContain(t("common.nothingChanged"));

      await wrapper.get("[data-testid='drawer-error-close']").trigger("click");
      expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
      expect(document.activeElement).toBe(wrapper.get(".drawer").element);
    } finally {
      vi.useRealTimers();
    }
  });

  it("behält den Entwurf bei einem Rescan derselben AppID (U-15)", async () => {
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");
    await input.setValue("gamemoderun %command%");

    // ein Rescan ersetzt den Snapshot; AppID und Bibliothek bleiben gleich
    scanState.scanGeneration = 2;
    scanState.result = result("available", "default", "default", null, { launchOptions: "" });
    await nextTick();

    expect(wrapper.get<HTMLInputElement>("#launch-options").element.value).toBe(
      "gamemoderun %command%",
    );
    expect(launchSaveButton(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("verwirft Entwurf und Fehler bei einem echten Spielwechsel (U-15)", async () => {
    configState.saveLaunchOptions.mockRejectedValueOnce("steam-running");
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();
    expect(wrapper.find(".blocked-explanation").exists()).toBe(true);

    switchToGame43();
    await nextTick();

    expect(wrapper.get<HTMLInputElement>("#launch-options").element.value).toBe("");
    expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
  });
});
