// @vitest-environment happy-dom

// T-08: die mock-preamble muss vor jedem src-/store-import geladen werden.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor den modul-importen laufen (T-08)
import {
  cleanupState,
  configState,
  footprint,
  measureGameFootprintMock,
  mountDrawer,
  requireElement,
  result,
  scanState,
  uiState,
} from "./GameDetailDrawer.preamble";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import type { ProtonCheck } from "../../src/core/protoncheck";
import { setLocale, t } from "../../src/ui/i18n";
import { game as makeGame, scanResult } from "../support/factories";

describe("GameDetailDrawer Config-Provenienz", () => {
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

  it("zeigt die appid in der metazeile mit einem leerzeichen", () => {
    uiState.selectedAppId = 620;
    const wrapper = mountDrawer(result("available", "default", "default", null, { appId: 620 }));

    expect(wrapper.get(".meta").text()).toBe("100 B · appid - 620");
  });

  it("zeigt den lokalisierten stufennamen statt der langbeschreibung", () => {
    // die kurznamen kommen aus der gemeinsamen tier-darstellung (tierName);
    // die früheren langbeschreibungen (toter `tier.*`-block, U-07) sind hier
    // bewusst nicht sichtbar.
    const withTier = (tier: "platinum" | "borked") =>
      scanResult({
        games: [
          makeGame({ protonDb: { tier, confidence: "strong" } }),
          ...result("available", "default", "default", null).games,
        ],
      });

    setLocale("de");
    const de = mountDrawer(withTier("platinum"));
    expect(de.get(".meta-tier").text()).toContain("Platin");
    expect(de.get(".meta-tier").text()).not.toContain("läuft perfekt, out of the box");

    setLocale("en");
    // die abfragen laufen über document.body (Teleport, siehe drawerDom.ts):
    // der erste mount muss weg, sonst trifft .meta-tier den alten drawer.
    de.unmount();
    document.body.innerHTML = "";
    const en = mountDrawer(withTier("borked"));
    expect(en.get(".meta-tier").text()).toContain("Borked");
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

describe("GameDetailDrawer Startoptionen-Hinweise", () => {
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
    uiState.closeGame.mockClear();
    configState.saveLaunchOptions.mockReset();
    configState.saveCompatTool.mockReset();
    configState.saveLaunchOptions.mockResolvedValue("written");
    configState.saveCompatTool.mockResolvedValue("written");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setLocale("en");
  });

  it.each([
    {
      draft: "gamemoderun",
      expected: "gamemoderun steht ohne %command%-Marker im Entwurf.",
    },
    {
      draft: "%command% A=1",
      expected: "Ein Assignment folgt auf %command% im Entwurf.",
    },
    {
      draft: "PROTON_LOG=1",
      expected: "Ein Assignment steht ohne %command%-Marker im Entwurf.",
    },
    {
      draft: "PROTON_LOG=1 %command%",
      expected: "Proton-Logging im Entwurf aktiv",
    },
  ])("zeigt die konservative Warnung für $draft", async ({ draft, expected }) => {
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: draft }),
    );

    const hints = wrapper.find("[data-testid='launch-hints']");
    expect(hints.attributes("role")).toBe("status");
    expect(hints.text()).toContain(expected);
    expect(hints.classes()).not.toContain("error");
  });

  it("zeigt mehrere Codes in stabiler Reihenfolge und lässt Speichern aktiv", async () => {
    const wrapper = mountDrawer(
      result("available", "default", "default", null, {
        launchOptions: "%command%",
      }),
    );

    const input = wrapper.get("#launch-options");
    await input.setValue("PROTON_LOG=1 gamemoderun %command% A=1");
    const save = input.element.parentElement?.querySelector<HTMLButtonElement>("button");
    const hints = wrapper.get("[data-testid='launch-hints']");
    expect(hints.text()).toContain("Ein Assignment folgt auf %command% im Entwurf.");
    expect(hints.text()).toContain("Proton-Logging im Entwurf aktiv");
    expect(hints.element.textContent?.indexOf("Ein Assignment")).toBeLessThan(
      hints.element.textContent?.indexOf("Proton-Logging") ?? 0,
    );
    expect(save?.disabled).toBe(false);

    await input.setValue("%command%");
    expect(wrapper.find("[data-testid='launch-hints']").exists()).toBe(false);
    expect(save?.disabled).toBe(true);
    expect(configState.saveLaunchOptions).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "scan läuft",
      status: "scanning" as const,
      launchConfigStatus: "available" as const,
      unavailable: false,
    },
    {
      label: "config fehlt",
      status: "done" as const,
      launchConfigStatus: "missing" as const,
      unavailable: true,
    },
    {
      label: "config nicht lesbar",
      status: "done" as const,
      launchConfigStatus: "unreadable" as const,
      unavailable: true,
    },
    {
      label: "config mehrdeutig",
      status: "done" as const,
      launchConfigStatus: "ambiguous" as const,
      unavailable: true,
    },
  ])(
    "analysiert bei $label keine Entwurfs-Hinweise",
    ({ status, launchConfigStatus, unavailable }) => {
      scanState.status = status;
      const wrapper = mountDrawer(
        result("available", "default", "default", null, {
          launchConfigStatus,
          launchOptions: "gamemoderun",
        }),
      );

      expect(wrapper.find("[data-testid='launch-hints']").exists()).toBe(false);
      expect(wrapper.find("[data-testid='launch-config-unavailable']").exists()).toBe(unavailable);
    },
  );

  it("ändert weder Eingabewert noch Save-Gate durch die Analyse", async () => {
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "gamemoderun" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");
    expect(input.element.value).toBe("gamemoderun");

    await input.setValue("gamemoderun %command%");
    expect(input.element.value).toBe("gamemoderun %command%");
    expect(input.element.parentElement?.querySelector("button")?.hasAttribute("disabled")).toBe(
      false,
    );
  });
});

describe("GameDetailDrawer Erklärungen", () => {
  beforeEach(() => {
    setLocale("de");
    uiState.selectedAppId = 42;
    uiState.inertMain = false;
    uiState.closeGame.mockReset();
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

  it.each(["de", "en"] as const)(
    "rendert alle kontextuellen Drawer-Erklärungen und isoliert den Parent-Trap in %s",
    async (locale) => {
      setLocale(locale);
      const opener = document.createElement("button");
      opener.type = "button";
      document.body.appendChild(opener);
      opener.focus();
      measureGameFootprintMock.mockResolvedValueOnce(
        footprint({
          compatdata: { status: "not-requested" },
          summary: { status: "partial", sizeBytes: 40 },
          externalCompatdata: true,
        }),
      );
      const wrapper = mountDrawer(
        result("missing", "default", "default", "proton_experimental", {
          launchOptions: "STEAM_COMPAT_DATA_PATH=/secret/user/prefix",
        }),
        ["tool-not-recognized"],
      );

      await wrapper.get("[data-testid='footprint-measure']").trigger("click");
      await nextTick();
      await nextTick();

      const triggers = wrapper.findAll("[data-testid='explain-trigger']");
      expect(triggers).toHaveLength(3);
      expect(triggers.map((trigger) => trigger.attributes("aria-label"))).toEqual([
        t("explain.open", { topic: t("explain.topics.protondb.title") }),
        t("explain.open", { topic: t("drawer.footprintTitle") }),
        t("explain.open", { topic: t("drawer.configuration") }),
      ]);

      const configTrigger = triggers[2];
      if (!configTrigger) throw new Error("erklärungs-trigger für config fehlt");
      await configTrigger.trigger("click");
      await nextTick();
      const dialog = requireElement(".explain-dialog");
      const close = requireElement("[data-testid='explain-close']", dialog);
      expect(dialog.textContent).toContain(t("explain.sourceLabel"));
      expect(dialog.textContent).toContain(t("explain.meaningLabel"));
      for (const title of [
        "explain.topics.compatTool.title",
        "explain.topics.compatSource.title",
        "explain.topics.configUnavailable.title",
        "explain.topics.globalDefault.title",
        "explain.topics.toolUnrecognized.title",
      ] as const) {
        expect(dialog.textContent).toContain(t(title));
      }

      const tabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      close.dispatchEvent(tabEvent);
      expect(tabEvent.defaultPrevented).toBe(true);
      expect(uiState.closeGame).not.toHaveBeenCalled();

      const escapeEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      close.dispatchEvent(escapeEvent);
      await nextTick();
      expect(escapeEvent.defaultPrevented).toBe(true);
      expect(uiState.closeGame).not.toHaveBeenCalled();
      expect(document.body.querySelector(".explain-dialog")).toBeNull();
      expect(document.activeElement).toBe(configTrigger.element);

      await configTrigger.trigger("click");
      await nextTick();
      scanState.result = result("available", "default", "default", null, { appId: 43 });
      uiState.selectedAppId = 43;
      await nextTick();
      expect(document.body.querySelector(".explain-dialog")).toBeNull();
    },
  );
});
