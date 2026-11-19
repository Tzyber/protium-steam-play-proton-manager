// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { version as packageVersion } from "../../package.json";

const rawUiState = vi.hoisted(() => ({
  activeView: "library",
  inertMain: true,
  selectedAppId: null as number | null,
  explanationCount: 0,
  notification: null as { message: string } | null,
  dismissNotification: vi.fn(),
  showNotification: vi.fn(),
  // Der Store setzt die Auswahl beim Verlassen der Library zurück; der Mock
  // bildet das nach, sonst wäre der Lockout im Test unsichtbar (V2).
  go(this: { activeView: string; selectedAppId: number | null }, view: string) {
    this.activeView = view;
    if (view !== "library") this.selectedAppId = null;
  },
}));
const mockUiState = reactive(rawUiState);
const rawScanState = vi.hoisted(() => ({
  result: null as { games: { appId: number }[]; libraries: string[] } | null,
  compatTools: [],
  elapsedMs: null,
  runScan: vi.fn(async () => {}),
}));
// reaktiv, weil die inert-Ableitung den Scan-Stand liest (V2)
const mockScanState = reactive(rawScanState);
const mockCheckForUpdate = vi.hoisted(() => vi.fn());
const mockOpenExternal = vi.hoisted(() => vi.fn());
const mockLogDiagnostic = vi.hoisted(() =>
  vi.fn<(level: string, message: string) => Promise<void>>(async () => {}),
);
const mockSettingsLoad = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const mockSettingsSave = vi.hoisted(() => vi.fn<(value: string) => Promise<void>>(async () => {}));

vi.mock("../../src/ui/components/ProtiumLogo.vue", () => ({
  default: { template: '<span aria-hidden="true" />' },
}));
vi.mock("../../src/ui/views/LibraryView.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("../../src/ui/views/ProtonManagerView.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("../../src/ui/views/CleanupView.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("../../src/ui/i18n", async () => {
  const { shallowRef } = await import("vue");
  const locale = shallowRef<"de" | "en">("en");
  return {
    locale,
    setLocale: (l: "de" | "en") => {
      locale.value = l;
    },
    t: (key: string, params?: Record<string, string | number>) =>
      key === "app.updateAvailable"
        ? `Protium v${params?.version} ist verfügbar (installiert: v${params?.current}).`
        : key,
  };
});
vi.mock("../../src/ui/stores/scanStore", () => ({
  useScanStore: () => mockScanState,
}));
vi.mock("../../src/ui/stores/uiStore", () => ({
  useUiStore: () => mockUiState,
}));
vi.mock("../../src/core/update", () => ({
  checkForUpdate: mockCheckForUpdate,
  UPDATE_RELEASE_URL: "https://github.com/Tzyber/protium-steam-play-proton-manager/releases",
}));
vi.mock("../../src/core/adapters/tauri", () => ({
  tauriPorts: {
    http: {},
    settings: { load: mockSettingsLoad, save: mockSettingsSave },
    system: { openExternal: mockOpenExternal, logDiagnostic: mockLogDiagnostic },
  },
}));

import App from "../../src/ui/App.vue";
import { setLocale } from "../../src/ui/i18n";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useLibraryStore } from "../../src/ui/stores/libraryStore";
import { useUiStore } from "../../src/ui/stores/uiStore";

const mounted: { unmount: () => void }[] = [];
function mountApp(options?: Parameters<typeof mount>[1]) {
  const wrapper = mount(App, options);
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  setLocale("en");
  mockUiState.activeView = "library";
  mockCheckForUpdate.mockResolvedValue(null);
  mockOpenExternal.mockResolvedValue(undefined);
  mockLogDiagnostic.mockResolvedValue(undefined);
  mockSettingsLoad.mockResolvedValue(null);
  mockSettingsSave.mockResolvedValue(undefined);
});

afterEach(() => {
  // Erst unmounten, dann reaktive Mocks zurücksetzen, damit kein alter Watch mehr feuert.
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = "";
  mockScanState.runScan.mockClear();
  mockUiState.inertMain = true;
  mockUiState.activeView = "library";
  mockUiState.showNotification.mockClear();
  setLocale("en");
  mockCheckForUpdate.mockReset();
  mockOpenExternal.mockReset();
  mockLogDiagnostic.mockReset();
  mockSettingsLoad.mockReset();
  mockSettingsSave.mockReset();
});

describe("App modal background", () => {
  it("zeigt die release-version aus dem paketstand im statusblock", () => {
    const wrapper = mountApp();

    expect(wrapper.get(".readout-version").text()).toContain(`v${packageVersion}`);
  });

  it("gibt dem hauptbereich einen programmatisch fokussierbaren skip-link-anker", () => {
    const wrapper = mountApp();

    expect(wrapper.get("#main-content").attributes("tabindex")).toBe("-1");
  });

  it("setzt inert auf die gesamte shell, wenn ein modal aktiv ist", () => {
    // V2: die sperre wird aus dem zustand abgeleitet, nicht vorab gesetzt.
    // Der Drawer zählt nur, wenn seine Auswahl im Scan auflösbar ist.
    mockUiState.selectedAppId = 620;
    mockScanState.result = { games: [{ appId: 620 }], libraries: [] };
    const wrapper = mountApp();

    expect(mockUiState.inertMain).toBe(true);
    mockUiState.selectedAppId = null;
    mockScanState.result = null;
    expect(wrapper.find(".shell").attributes("inert")).toBeUndefined();
    expect(wrapper.find(".sidebar").attributes("inert")).toBeUndefined();
  });

  it("confirm-dialog setzt inert beim öffnen und räumt beim schließen auf", async () => {
    mockUiState.inertMain = false;
    const wrapper = mountApp();
    await nextTick();
    expect(wrapper.find(".app-background").attributes("inert")).toBeUndefined();

    useConfirmStore().pending = { title: "löschen?" } as never;
    await nextTick();
    expect(mockUiState.inertMain).toBe(true);

    useConfirmStore().pending = null;
    await nextTick();
    expect(mockUiState.inertMain).toBe(false);
  });

  it("rendert den bestätigungsdialog nach ansichtswechsel zwischen reserve und ask", async () => {
    mockUiState.inertMain = false;
    const wrapper = mountApp({ attachTo: document.body });
    const confirm = useConfirmStore();
    try {
      await nextTick();
      expect(wrapper.find(".app-background").attributes("inert")).toBeUndefined();

      const token = confirm.reserve();
      if (token === null) throw new Error("reserve lieferte kein token");

      const ui = useUiStore();
      ui.go("proton");
      await nextTick();
      ui.go("library");
      await nextTick();

      expect(confirm.ask({ title: "entfernen?", message: "folge" }, {}, token)).toBe(true);
      await nextTick();
      const dialog = document.querySelector('[role="dialog"]');
      const main = document.getElementById("main-content");
      expect(dialog).not.toBeNull();
      expect(dialog?.closest("[inert]")).toBeNull();
      expect(main?.closest("[inert]")).not.toBeNull();

      dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await nextTick();
      await nextTick();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(main?.closest("[inert]")).toBeNull();
    } finally {
      wrapper.unmount();
      document.body.innerHTML = "";
      confirm.cancel();
    }
  });

  it("verschachtelte dialoge halten die sperre, bis der letzte schliesst (V2)", async () => {
    // V2: drawer offen + erklär-panel offen. Schliesst das panel, bleibt der
    // hintergrund inert, solange der drawer offen ist.
    mockUiState.inertMain = false;
    mountApp();
    await nextTick();

    const ui = useUiStore();
    ui.selectedAppId = 620;
    mockScanState.result = { games: [{ appId: 620 }], libraries: [] };
    ui.explanationCount = 1;
    await nextTick();
    expect(mockUiState.inertMain).toBe(true);

    ui.explanationCount = 0;
    await nextTick();
    expect(mockUiState.inertMain).toBe(true);

    ui.selectedAppId = null;
    mockScanState.result = null;
    await nextTick();
    expect(mockUiState.inertMain).toBe(false);
  });

  it("gibt die sperre frei, wenn die auswahl im scan nicht mehr existiert (Review V2)", async () => {
    // Rescan ohne das offene Spiel: der Drawer rendert nichts, die Sperre darf
    // nicht stehen bleiben (sonst ist die Navigation gesperrt).
    mockUiState.inertMain = false;
    mountApp();
    const ui = useUiStore();
    ui.selectedAppId = 620;
    mockScanState.result = { games: [{ appId: 620 }], libraries: [] };
    await nextTick();
    expect(mockUiState.inertMain).toBe(true);

    mockScanState.result = { games: [{ appId: 999 }], libraries: [] };
    await nextTick();
    expect(mockUiState.inertMain).toBe(false);

    ui.selectedAppId = null;
    mockScanState.result = null;
  });

  it("gibt die sperre beim ansichtswechsel frei (Review V2)", async () => {
    mockUiState.inertMain = false;
    mountApp();
    const ui = useUiStore();
    ui.selectedAppId = 620;
    mockScanState.result = { games: [{ appId: 620 }], libraries: [] };
    await nextTick();
    expect(mockUiState.inertMain).toBe(true);

    ui.go("cleanup");
    await nextTick();
    expect(ui.selectedAppId).toBeNull();
    expect(mockUiState.inertMain).toBe(false);

    mockScanState.result = null;
    ui.activeView = "library";
  });
});

describe("App update-hinweis", () => {
  it("zeigt bei neuer version einen schließbaren release-hinweis", async () => {
    mockCheckForUpdate.mockResolvedValue("0.6.11");
    const wrapper = mountApp();
    await flushPromises();

    expect(wrapper.get(".update-notice").text()).toContain(
      `Protium v0.6.11 ist verfügbar (installiert: v${packageVersion}).`,
    );
    await wrapper.get(".update-close").trigger("click");
    expect(wrapper.find(".update-notice").exists()).toBe(false);
  });

  it("öffnet den release-tag der neuen version", async () => {
    mockCheckForUpdate.mockResolvedValue("0.6.11");
    const wrapper = mountApp();
    await flushPromises();

    await wrapper.get(".update-open").trigger("click");
    expect(mockOpenExternal).toHaveBeenCalledWith(
      "https://github.com/Tzyber/protium-steam-play-proton-manager/releases/tag/v0.6.11",
    );
  });

  it("bleibt bei einem unerwarteten update-check-fehler ohne hinweis", async () => {
    mockCheckForUpdate.mockRejectedValue(new Error("offline"));
    const wrapper = mountApp();
    await flushPromises();

    expect(wrapper.find(".update-notice").exists()).toBe(false);
  });

  it("meldet, wenn der release-link nicht geöffnet werden kann", async () => {
    mockCheckForUpdate.mockResolvedValue("0.6.11");
    mockOpenExternal.mockRejectedValueOnce(new Error("handler-unavailable"));
    const ui = useUiStore();
    const wrapper = mountApp();
    await flushPromises();

    await wrapper.get(".update-open").trigger("click");
    await flushPromises();

    expect(ui.showNotification).toHaveBeenCalledWith("app.openReleaseFailed");
  });
});

describe("App Fehler kopieren", () => {
  it("behält den aktionsnamen und meldet den fehlschlag nur in der live-region (U-14)", async () => {
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    try {
      mockUiState.notification = { message: "kein platz" };
      const wrapper = mountApp();

      await wrapper.get(".note-copy").trigger("click");
      await flushPromises();

      // der knopf kopiert weiterhin: name = aktion, nicht der fehlertext
      const button = wrapper.get(".note-copy");
      expect(button.attributes("aria-label")).toBe("app.copyError");
      expect(button.text()).toBe("⚠");
      expect(wrapper.get(".sr-only[role='alert']").text()).toBe("app.copyFailed");
    } finally {
      if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
      mockUiState.notification = null;
    }
  });

  it("quittiert ein erfolgreiches kopieren mit häkchen und kopiert-status", async () => {
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    try {
      mockUiState.notification = { message: "kein platz" };
      const wrapper = mountApp();

      await wrapper.get(".note-copy").trigger("click");
      await flushPromises();

      const button = wrapper.get(".note-copy");
      expect(button.attributes("aria-label")).toBe("app.copied");
      expect(button.text()).toBe("✓");
    } finally {
      if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
      mockUiState.notification = null;
    }
  });
});

describe("App Settings-Persistenz", () => {
  it("schreibt beim mount ohne änderung nicht", async () => {
    mountApp();
    await flushPromises();
    expect(mockSettingsSave).not.toHaveBeenCalled();
  });

  it("persistiert änderungen an sprache, ansicht und sortierung über ports.settings.save", async () => {
    mountApp();
    const ui = useUiStore();
    const lib = useLibraryStore();
    await flushPromises();
    expect(mockSettingsSave).not.toHaveBeenCalled();

    ui.go("proton");
    await nextTick();
    expect(mockSettingsSave).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockSettingsSave.mock.calls[0]?.[0] ?? "")).toEqual({
      language: "en",
      view: "proton",
      sortKey: "name",
      sortDir: "asc",
    });

    lib.setSort("size");
    await nextTick();
    expect(mockSettingsSave).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockSettingsSave.mock.calls[1]?.[0] ?? "")).toEqual({
      language: "en",
      view: "proton",
      sortKey: "size",
      sortDir: "desc",
    });

    setLocale("de");
    await nextTick();
    expect(mockSettingsSave).toHaveBeenCalledTimes(3);
    expect(JSON.parse(mockSettingsSave.mock.calls[2]?.[0] ?? "")).toEqual({
      language: "de",
      view: "proton",
      sortKey: "size",
      sortDir: "desc",
    });
  });

  it("protokolliert save-fehler via logError ohne toast und ohne unbehandelte rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    mockSettingsSave.mockRejectedValueOnce(new Error("disk full"));
    mountApp();
    const ui = useUiStore();
    try {
      await flushPromises();

      ui.go("cleanup");
      await flushPromises();

      expect(mockSettingsSave).toHaveBeenCalledTimes(1);
      expect(mockLogDiagnostic).toHaveBeenCalledWith("error", expect.stringContaining("disk full"));
      expect(mockUiState.showNotification).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
