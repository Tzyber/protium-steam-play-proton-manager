// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { version as appVersion } from "../../package.json";
import type { IncompleteDeletion } from "../../src/core/cleanup";
import type { WriteResult } from "../../src/core/ports";
import type { Game, ScanResult } from "../../src/core/types";

const { measureGameFootprintMock, openExternalMock } = vi.hoisted(() => ({
  measureGameFootprintMock: vi.fn(),
  openExternalMock: vi.fn(async () => {}),
}));

vi.mock("../../src/core/adapters/tauri", () => ({
  openExternal: openExternalMock,
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

import { projectSupportFacts } from "../../src/core/support";
import GameDetailDrawer from "../../src/ui/components/GameDetailDrawer.vue";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfigStore } from "../../src/ui/stores/configStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { useUiStore } from "../../src/ui/stores/uiStore";
import { formatSupportFacts } from "../../src/ui/supportText";

const marker = "fixture-secret-934";
const privatePath = "/home/fixture-private-user/.steam/userdata/76561198012345678";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function game(overrides: Partial<Game> = {}): Game {
  return {
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
  };
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
    "exportiert bei leerem und nie gescanntem Cleanup-Store in %s nur unbekannte Zustände",
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
        locale === "de" ? "abgebrochene Löschung: unbekannt" : "incomplete deletion: unknown",
      );
      expect(copied).toContain(
        locale === "de" ? "Bereinigungsfreigabe: unbekannt" : "cleanup clearance: unknown",
      );
      expect(copied).not.toContain(locale === "de" ? "Bereinigung blockiert" : "Cleanup blocked");
      expect(copied).not.toContain(
        locale === "de" ? "abgebrochene Löschung: 0" : "incomplete deletion: 0",
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
    expect(button.attributes("disabled")).toBeDefined();
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
    expect(button.attributes("disabled")).toBeDefined();
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
    expect(wrapper.get("[data-testid='support-copy']").attributes("disabled")).toBeDefined();
    expect(writeText).not.toHaveBeenCalled();

    pendingSave.resolve("written");
    await flushPromises();
    await nextTick();
    expect(wrapper.get("[data-testid='support-copy']").attributes("disabled")).toBeUndefined();
  });
});
