// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { version as appVersion } from "../../package.json";
import type { IncompleteDeletion } from "../../src/core/cleanup";
import type { WriteResult } from "../../src/core/ports";
import type { Game, ScanResult } from "../../src/core/types";

const { measureGameFootprintMock, openExternalMock, openPrefixFolderMock } = vi.hoisted(() => ({
  measureGameFootprintMock: vi.fn(),
  openExternalMock: vi.fn(async () => {}),
  openPrefixFolderMock: vi.fn(async () => {}),
}));

vi.mock("../../src/core/adapters/tauri", () => ({
  openExternal: openExternalMock,
  openPrefixFolder: openPrefixFolderMock,
  tauriPorts: { system: {} },
}));
vi.mock("../../src/core/footprint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/footprint")>();
  return { ...actual, measureGameFootprint: measureGameFootprintMock };
});
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
      '<select data-testid="select-box"><option v-for="option in options" :key="option.value">{{ option.label }}</option></select>',
  },
}));
vi.mock("../../src/ui/components/TierBadge.vue", () => ({
  default: { template: '<span data-testid="tier-badge" />' },
}));

import { tauriPorts } from "../../src/core/adapters/tauri";
import { projectSupportFacts } from "../../src/core/support";
import GameDetailDrawer from "../../src/ui/components/GameDetailDrawer.vue";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfigStore } from "../../src/ui/stores/configStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { useUiStore } from "../../src/ui/stores/uiStore";
import { formatSupportFacts } from "../../src/ui/supportText";
import { usePrefixOpen } from "../../src/ui/usePrefixOpen";
import { deferred, game as makeGame } from "../support/factories";

const marker = "fixture-secret-934";
const privatePath = "/home/fixture-private-user/.steam/userdata/76561198012345678";

// marker und privatePath stehen in jeder figur: der test prüft, dass nichts
// davon in die kopierte diagnose oder in logs leckt.
function game(overrides: Partial<Game> = {}): Game {
  return makeGame({
    appId: 620,
    name: `Game ${marker}`,
    library: `${privatePath}/steamapps`,
    sizeBytes: 0,
    installdir: "fixture-install",
    compatTool: marker,
    compatToolSource: "explicit",
    protonDb: { tier: "gold", confidence: marker },
    localHeader: `https://${marker}/header.png`,
    headerImage: `https://${marker}/fallback.png`,
    launchOptions: `PROTON_LOG=1 STEAM_COMPAT_DATA_PATH=${privatePath}/${marker} %command%`,
    ...overrides,
  });
}

function scanResult(currentGame: Game = game(), overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    steamRoot: privatePath,
    libraries: [currentGame.library],
    games: [currentGame],
    compatToolsInstalled: [
      {
        name: marker,
        internalName: marker,
        displayName: marker,
        sizeBytes: 0,
        usedBy: [currentGame.appId],
        source: "user",
      },
    ],
    builtinProtonsInstalled: [],
    defaultCompatTool: null,
    compatConfigStatus: "available",
    steamUserId: "76561198012345678",
    launchConfigStatus: "available",
    manifestCounts: { read: 1, failed: 0 },
    compatToolCounts: { read: 1, failed: 0 },
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
    blockedAppIds: [],
    ...overrides,
  };
}

function seedCleanup(store: ReturnType<typeof useCleanupStore>): void {
  const claim = (type: IncompleteDeletion["type"], suffix: string): IncompleteDeletion => ({
    path: `${privatePath}/${suffix}`,
    library: privatePath,
    type,
    name: marker,
  });

  store.scanning = false;
  store.trashScanning = false;
  store.incompleteDeletions = [
    claim("compatdata", "claim-prefix"),
    claim("shadercache", "claim-shader"),
    claim("trash", "claim-trash"),
  ];
  store.incompleteDeletionsUnreadable = [`${privatePath}/unreadable-claim-parent`];
}

function cleanupInput(store: ReturnType<typeof useCleanupStore>) {
  return {
    scanning: store.scanning,
    trashScanning: store.trashScanning,
    prefixUnavailable: store.prefixUnavailable,
    shaderUnavailable: store.shaderUnavailable,
    trashUnavailable: store.trashUnavailable,
    incompleteDeletionsCount: store.incompleteDeletions.length,
    incompleteDeletionsUnreadable: store.incompleteDeletionsUnreadable.length > 0,
  };
}

const mountedWrappers: { unmount: () => void }[] = [];
let previousClipboard: PropertyDescriptor | undefined;

function installClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function mountDrawer(locale: "de" | "en" = "en") {
  setLocale(locale);
  setActivePinia(createPinia());
  const scan = useScanStore();
  const ui = useUiStore();
  const cleanup = useCleanupStore();
  const config = useConfigStore();
  const current = game();
  const result = scanResult(current);
  scan.status = "done";
  scan.scanGeneration = 7;
  scan.result = result;
  ui.selectedAppId = current.appId;
  const wrapper = mount(GameDetailDrawer, {
    attachTo: document.body,
    global: { stubs: { Teleport: true } },
  });
  mountedWrappers.push(wrapper);
  return { wrapper, current, result, scan, ui, cleanup, config };
}

beforeEach(() => {
  previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  measureGameFootprintMock.mockReset();
  openPrefixFolderMock.mockReset();
  openPrefixFolderMock.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
  if (previousClipboard) {
    Object.defineProperty(navigator, "clipboard", previousClipboard);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  document.body.innerHTML = "";
  setLocale("en");
});

describe("GameDetailDrawer SupportFacts-Integration", () => {
  it.each(["de", "en"] as const)(
    "kopiert in %s exakt die anonymisierte Faktenprojektion mit positivem Cleanup-Anzeigestand",
    async (locale) => {
      const writeText = vi.fn(async (_text: string) => {});
      installClipboard(writeText);
      const { wrapper, current, scan, cleanup } = mountDrawer(locale);
      seedCleanup(cleanup);
      const rescannedResult = scanResult(game());
      scan.status = "scanning";
      scan.scanGeneration = 8;
      scan.result = rescannedResult;
      scan.status = "done";
      await nextTick();
      await nextTick();

      await wrapper.get("[data-testid='support-copy']").trigger("click");
      await flushPromises();
      await nextTick();

      const expected = formatSupportFacts(
        projectSupportFacts({
          game: current,
          result: rescannedResult,
          cleanup: cleanupInput(cleanup),
        }),
        appVersion,
      );
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(expected);
      expect(wrapper.get("[data-testid='support-copy-status']").text()).toBe(
        t("drawer.supportCopied"),
      );
      expect(wrapper.find("[role='alert']").exists()).toBe(false);
      expect(expected).toContain("<steam-library-1>");
      expect(expected).toContain("<compat-tool-1>");
      expect(expected).toContain(
        locale === "de" ? "vorhandener Anzeigestand" : "existing displayed state",
      );
      expect(expected).not.toContain(marker);
      expect(expected).not.toContain(privatePath);
      expect(expected).not.toContain("76561198012345678");
    },
  );

  it.each(["de", "en"] as const)(
    "exportiert bei leerem und nie gescanntem Cleanup-Store in %s den zusammengefassten Befund",
    async (locale) => {
      const writeText = vi.fn(async (_text: string) => {});
      installClipboard(writeText);
      const { wrapper } = mountDrawer(locale);

      await wrapper.get("[data-testid='support-copy']").trigger("click");
      await flushPromises();

      const copied = writeText.mock.calls[0]?.[0];
      expect(copied).toEqual(expect.any(String));
      if (typeof copied !== "string") return;
      expect(copied).toContain(
        locale === "de"
          ? "Bereinigung: kein Befund im vorhandenen Anzeigestand (keine Blockade, keine abgebrochene Löschung; Aktualität und Freigabe unbekannt)"
          : "Cleanup: no findings in the displayed state (no blockade, no incomplete deletion; freshness and clearance unknown)",
      );
      expect(copied).not.toContain(locale === "de" ? "Bereinigung blockiert" : "Cleanup blocked");
      expect(copied).not.toContain(
        locale === "de" ? "Abgebrochene Löschung: 0" : "Incomplete deletion: 0",
      );
    },
  );

  it("sperrt Kopieren während eines laufenden Scans", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    installClipboard(writeText);
    const { wrapper, scan } = mountDrawer();
    scan.status = "scanning";
    await nextTick();

    const button = wrapper.get("[data-testid='support-copy']");
    expect(button.attributes("disabled")).toBe("");
    await button.trigger("click");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("nimmt beim Klick genau einen Snapshot, sperrt Doppelclicks und verwirft späten Erfolg nach Rescan", async () => {
    const pending = deferred<void>();
    const writeText = vi.fn((_text: string) => pending.promise);
    installClipboard(writeText);
    const { wrapper, scan } = mountDrawer();
    const button = wrapper.get("[data-testid='support-copy']");

    await button.trigger("click");
    await nextTick();
    expect(button.attributes("disabled")).toBe("");
    await button.trigger("click");
    expect(writeText).toHaveBeenCalledTimes(1);
    const snapshot = writeText.mock.calls[0]?.[0];
    expect(snapshot).toEqual(expect.any(String));

    scan.result = scanResult(game({ name: "new game after rescan" }));
    scan.scanGeneration = 8;
    await nextTick();
    await nextTick();
    pending.resolve();
    await flushPromises();
    await nextTick();

    expect(writeText.mock.calls[0]?.[0]).toBe(snapshot);
    expect(wrapper.find("[data-testid='support-copy-status']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='support-copy-error']").exists()).toBe(false);
  });

  it.each(["de", "en"] as const)(
    "zeigt bei Clipboard-Fehler in %s nur den generischen lokalen Fehler",
    async (locale) => {
      const writeText = vi.fn(async (_text: string) => {
        throw new Error(marker);
      });
      installClipboard(writeText);
      const { wrapper } = mountDrawer(locale);

      await wrapper.get("[data-testid='support-copy']").trigger("click");
      await flushPromises();
      await nextTick();

      const error = wrapper.get("[data-testid='support-copy-error']");
      expect(error.attributes("role")).toBe("alert");
      expect(error.text()).toBe(t("drawer.supportCopyError"));
      expect(error.text()).not.toContain(marker);
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0]?.[0]).not.toContain(marker);
    },
  );

  it("behandelt fehlende Clipboard-API wie jeden anderen generischen Kopierfehler", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const { wrapper } = mountDrawer();

    await wrapper.get("[data-testid='support-copy']").trigger("click");
    await nextTick();

    expect(wrapper.get("[data-testid='support-copy-error']").text()).toBe(
      t("drawer.supportCopyError"),
    );
  });

  it.each(["close", "unmount"] as const)(
    "invalidiert eine laufende Kopie beim %s ohne späten Status",
    async (action) => {
      const pending = deferred<void>();
      const writeText = vi.fn((_text: string) => pending.promise);
      installClipboard(writeText);
      const { wrapper, ui } = mountDrawer();

      await wrapper.get("[data-testid='support-copy']").trigger("click");
      if (action === "close") {
        ui.closeGame();
        await nextTick();
        await nextTick();
      } else {
        wrapper.unmount();
      }
      pending.resolve();
      await flushPromises();
      await nextTick();

      expect(document.querySelector("[data-testid='support-copy-status']")).toBeNull();
      expect(document.querySelector("[data-testid='support-copy-error']")).toBeNull();
    },
  );

  it("ruft durch den Support-Klick weder Messung noch Save-Aktionen auf", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    installClipboard(writeText);
    const { wrapper, config } = mountDrawer();
    const saveLaunch = vi.spyOn(config, "saveLaunchOptions");
    const saveCompat = vi.spyOn(config, "saveCompatTool");
    const explanationTrigger = wrapper.find("[data-testid='explain-trigger']");
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await explanationTrigger.trigger("click");
    await input.setValue("draft without saving");

    await wrapper.get("[data-testid='support-copy']").trigger("click");
    await flushPromises();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(measureGameFootprintMock).not.toHaveBeenCalled();
    expect(openExternalMock).not.toHaveBeenCalled();
    expect(saveLaunch).not.toHaveBeenCalled();
    expect(saveCompat).not.toHaveBeenCalled();
  });

  it("übernimmt einen geschriebenen Startoptionen-Save in die scan-wahrheit", async () => {
    // F3/F1-Regression: der Erfolgspfad muss über den echten Config-Store
    // laufen (applyGameConfig per appId) und darf den neuen Wächter nicht
    // verlieren.
    const system = tauriPorts.system as { saveLaunchOptions?: unknown };
    const save = vi.fn(async () => "written" as WriteResult);
    system.saveLaunchOptions = save;
    try {
      const { wrapper, current } = mountDrawer();
      const input = wrapper.get<HTMLInputElement>("#launch-options");

      await input.setValue("MANGOHUD=1 %command%");
      await input.trigger("keydown", { key: "Enter" });
      await flushPromises();
      await nextTick();

      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(
        current.library.split("/steamapps")[0],
        expect.any(String),
        current.appId,
        "MANGOHUD=1 %command%",
      );
      expect(current.launchOptions).toBe("MANGOHUD=1 %command%");
      expect(input.element.value).toBe("MANGOHUD=1 %command%");

      const saveButton = input.element.parentElement?.querySelector<HTMLButtonElement>("button");
      expect(saveButton?.disabled).toBe(true);
      expect(saveButton?.textContent).toContain(t("drawer.saved"));
    } finally {
      Reflect.deleteProperty(system, "saveLaunchOptions");
    }
  });

  it("deaktiviert den Support-Klick während eines laufenden Config-Saves", async () => {
    const pendingSave = deferred<WriteResult>();
    const writeText = vi.fn(async (_text: string) => {});
    installClipboard(writeText);
    const { wrapper, config } = mountDrawer();
    const saveLaunch = vi
      .spyOn(config, "saveLaunchOptions")
      .mockImplementation(() => pendingSave.promise);
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("draft value");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();

    expect(saveLaunch).toHaveBeenCalledTimes(1);
    expect(wrapper.get("[data-testid='support-copy']").attributes("disabled")).toBe("");
    expect(writeText).not.toHaveBeenCalled();

    pendingSave.resolve("written");
    await flushPromises();
    await nextTick();
    expect(wrapper.get("[data-testid='support-copy']").attributes("disabled")).toBeUndefined();
  });
});

describe("Prefix-Ordner öffnen", () => {
  function prefixContext() {
    setActivePinia(createPinia());
    const scan = useScanStore();
    const current = ref<Game | null>(game({ launchOptions: "%command%" }));
    const saving = ref(false);
    scan.result = scanResult(game({ launchOptions: "%command%" }));
    scan.status = "done";
    const scope = effectScope();
    const prefix = scope.run(() => usePrefixOpen(current, saving));
    if (!prefix) throw new Error("prefix scope missing");
    mountedWrappers.push({ unmount: () => scope.stop() });
    return { current, saving, scan, prefix };
  }

  it.each(["saving", "spiel", "library", "startoptionen", "scan", "quelle", "schließen"])(
    "invalidiert bei Rückkehr zum gleichen Kontext ohne Tick: %s",
    async (change) => {
      const { current, saving, scan, prefix } = prefixContext();
      const pending = deferred<void>();
      openPrefixFolderMock.mockReturnValueOnce(pending.promise);
      const request = prefix.open();
      const original = current.value;
      const originalResult = scan.result;
      if (change === "saving") saving.value = true;
      else if (change === "scan") scan.status = "scanning";
      else if (change === "quelle")
        scan.result = scanResult(game(), { launchConfigStatus: "unreadable" });
      else if (change === "schließen") current.value = null;
      else
        current.value = game({
          launchOptions: change === "startoptionen" ? "" : "%command%",
          appId: change === "spiel" ? 570 : 620,
          library: change === "library" ? "/other" : game().library,
        });
      saving.value = false;
      scan.status = "done";
      scan.result = originalResult;
      current.value = original;
      expect(prefix.state.value).toBe("idle");
      pending.resolve();
      await request;
      expect(prefix.state.value).toBe("idle");
    },
  );

  it.each(["opened", "failed"])("reaktiviert fertiges Ergebnis %s nicht", async (state) => {
    const { saving, prefix } = prefixContext();
    if (state === "failed") openPrefixFolderMock.mockRejectedValueOnce("not-found");
    await prefix.open();
    expect(prefix.state.value).toBe(state);
    saving.value = true;
    await nextTick();
    saving.value = false;
    await nextTick();
    expect(prefix.state.value).toBe("idle");
  });

  it.each(["erfolg", "fehler"])(
    "alte Antwort (%s) überschreibt neue Anfrage nicht",
    async (end) => {
      const { saving, prefix } = prefixContext();
      const old = deferred<void>();
      const latest = deferred<void>();
      openPrefixFolderMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
      const first = prefix.open();
      saving.value = true;
      saving.value = false;
      const second = prefix.open();
      expect(openPrefixFolderMock).toHaveBeenCalledTimes(2);
      if (end === "erfolg") old.resolve();
      else old.reject("not-found");
      await first;
      expect(prefix.state.value).toBe("opening");
      latest.resolve();
      await second;
      expect(prefix.state.value).toBe("opened");
    },
  );

  async function ready(locale: "de" | "en" = "de") {
    const context = mountDrawer(locale);
    context.scan.result = scanResult(game({ launchOptions: "%command%" }));
    await nextTick();
    return context;
  }

  it("sitzt in der Konfiguration und nicht in der Footprint-Sektion", async () => {
    const { wrapper } = await ready();
    const button = wrapper.get('[data-testid="prefix-open"]');
    expect(
      wrapper.get('[data-testid="footprint-section"]').find('[data-testid="prefix-open"]').exists(),
    ).toBe(false);
    const launch = wrapper.get("#launch-options").element;
    const following =
      launch.compareDocumentPosition(button.element) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(following).toBeTruthy();
  });

  it("öffnet erst beim Klick ohne vorherige Messung und meldet nur den Handlerstart", async () => {
    const { wrapper, current } = await ready();
    const button = wrapper.get('[data-testid="prefix-open"]');
    expect(button.text()).toBe("Prefix-Ordner öffnen");
    expect(button.attributes("disabled")).toBeUndefined();
    expect(measureGameFootprintMock).not.toHaveBeenCalled();
    expect(openPrefixFolderMock).not.toHaveBeenCalled();
    await button.trigger("click");
    await flushPromises();
    expect(openPrefixFolderMock).toHaveBeenCalledExactlyOnceWith(current.library, current.appId);
    expect(wrapper.get('[data-testid="prefix-status"]').text()).toBe("Dateimanager gestartet");
    expect(wrapper.get('[data-testid="prefix-status"]').attributes("role")).toBe("status");
  });

  it.each([
    "STEAM_COMPAT_DATA_PATH=/secret",
    "FOO=1 STEAM_COMPAT_DATA_PATH=/secret",
    "env -i STEAM_COMPAT_DATA_PATH=/secret",
  ])("sperrt externe Zielkennung: %s", async (launchOptions) => {
    const { wrapper, scan } = await ready();
    scan.result = scanResult(game({ launchOptions }));
    await nextTick();
    const button = wrapper.get('[data-testid="prefix-open"]');
    expect(button.attributes("disabled")).toBe("");
    expect(wrapper.get('[data-testid="prefix-reason"]').text()).toContain(
      "Standardziel ist nicht belegt",
    );
    expect(wrapper.get('[data-testid="prefix-reason"]').text()).not.toContain("/secret");
    await button.trigger("click");
    expect(openPrefixFolderMock).not.toHaveBeenCalled();
  });

  it.each(["missing", "unreadable", "ambiguous"] as const)(
    "sperrt unklare Startoptionen: %s",
    async (launchConfigStatus) => {
      const { wrapper, scan } = await ready();
      scan.result = scanResult(game({ launchOptions: "" }), { launchConfigStatus });
      await nextTick();
      expect(wrapper.get('[data-testid="prefix-open"]').attributes("disabled")).toBe("");
      expect(wrapper.get('[data-testid="prefix-reason"]').text()).toContain(
        "Startoptionen sind nicht eindeutig verfügbar",
      );
      await wrapper.get('[data-testid="prefix-open"]').trigger("click");
      expect(openPrefixFolderMock).not.toHaveBeenCalled();
    },
  );

  it("nennt laufendes Speichern als Sperrgrund", async () => {
    const { wrapper, config } = await ready();
    const saveLaunch = vi
      .spyOn(config, "saveLaunchOptions")
      .mockImplementation(() => deferred<WriteResult>().promise);
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();

    expect(saveLaunch).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="prefix-open"]').attributes("disabled")).toBe("");
    expect(wrapper.get('[data-testid="prefix-reason"]').text()).toContain("gespeichert");
  });

  it("sperrt laufenden Scan und schließt den Drawer ohne Scan-Ergebnis", async () => {
    const { wrapper, scan } = await ready();
    scan.status = "scanning";
    await nextTick();
    expect(wrapper.get('[data-testid="prefix-open"]').attributes("disabled")).toBe("");
    expect(wrapper.get('[data-testid="prefix-reason"]').text()).toContain(
      "Scan ist nicht abgeschlossen",
    );
    scan.result = null;
    await nextTick();
    expect(wrapper.find('[data-testid="prefix-open"]').exists()).toBe(false);
    expect(openPrefixFolderMock).not.toHaveBeenCalled();
  });

  it.each(["de", "en"] as const)("übersetzt alle Fehler pfadfrei in %s", async (locale) => {
    const { wrapper } = await ready(locale);
    const messages: Record<string, string> = {};
    for (const code of [
      "external-target",
      "unchecked",
      "not-found",
      "unreadable",
      "blocked",
      "handler-unavailable",
      `/secret/${marker}`,
      new Error(`/secret/${marker}`),
    ]) {
      openPrefixFolderMock.mockRejectedValueOnce(code);
      await wrapper.get('[data-testid="prefix-open"]').trigger("click");
      await flushPromises();
      const message = wrapper.get('[data-testid="prefix-status"]');
      expect(message.attributes("role")).toBe("alert");
      expect(message.text()).not.toContain("/secret");
      expect(message.text()).not.toContain(marker);
      messages[typeof code === "string" && !code.startsWith("/") ? code : "unexpected"] =
        message.text();
    }
    expect(messages).toMatchSnapshot();
  });

  it("unterbindet Doppelklicks solange der Handlerstart aussteht", async () => {
    const { wrapper } = await ready();
    const pending = deferred<void>();
    openPrefixFolderMock.mockReturnValueOnce(pending.promise);
    await wrapper.get('[data-testid="prefix-open"]').trigger("click");
    expect(wrapper.get('[data-testid="prefix-open"]').attributes("disabled")).toBe("");
    await wrapper.get('[data-testid="prefix-open"]').trigger("click");
    expect(openPrefixFolderMock).toHaveBeenCalledTimes(1);
    pending.resolve();
    await flushPromises();
    expect(wrapper.get('[data-testid="prefix-open"]').attributes("disabled")).toBeUndefined();
  });

  it.each(["spiel", "library", "rescan", "startoptionen", "schließen", "unmount"])(
    "verwirft alte Antwort nach %s",
    async (change) => {
      const { wrapper, scan, ui } = await ready();
      const pending = deferred<void>();
      openPrefixFolderMock.mockReturnValueOnce(pending.promise);
      await wrapper.get('[data-testid="prefix-open"]').trigger("click");
      if (change === "spiel") {
        scan.result = scanResult(game({ appId: 570, launchOptions: "" }));
        ui.selectedAppId = 570;
      } else if (change === "library")
        scan.result = scanResult(game({ library: "/other", launchOptions: "" }));
      else if (change === "rescan") scan.scanGeneration += 1;
      else if (change === "startoptionen")
        scan.result = scanResult(game({ launchOptions: "STEAM_COMPAT_DATA_PATH=/secret" }));
      else if (change === "schließen") {
        ui.selectedAppId = null;
        await nextTick();
        ui.selectedAppId = 620;
      } else wrapper.unmount();
      pending.resolve();
      await flushPromises();
      expect(wrapper.text()).not.toContain("Dateimanager gestartet");
    },
  );
});
