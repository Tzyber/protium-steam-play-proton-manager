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
  notification: null,
  dismissNotification: vi.fn(),
}));
const mockUiState = reactive(rawUiState);
const mockScanState = vi.hoisted(() => ({
  result: null,
  compatTools: [],
  elapsedMs: null,
  runScan: vi.fn(async () => {}),
}));
const mockCheckForUpdate = vi.hoisted(() => vi.fn());
const mockOpenExternal = vi.hoisted(() => vi.fn());

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
vi.mock("../../src/ui/i18n", () => ({
  t: (key: string, params?: Record<string, string | number>) =>
    key === "app.updateAvailable"
      ? `Protium v${params?.version} ist verfügbar (installiert: v${params?.current}).`
      : key,
}));
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
  openExternal: mockOpenExternal,
  tauriPorts: { http: {} },
}));

import App from "../../src/ui/App.vue";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useUiStore } from "../../src/ui/stores/uiStore";

beforeEach(() => {
  setActivePinia(createPinia());
  mockCheckForUpdate.mockResolvedValue(null);
  mockOpenExternal.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  mockScanState.runScan.mockClear();
  mockUiState.inertMain = true;
  mockCheckForUpdate.mockReset();
  mockOpenExternal.mockReset();
});

describe("App modal background", () => {
  it("zeigt die release-version aus dem paketstand im statusblock", () => {
    const wrapper = mount(App);

    expect(wrapper.get(".readout-version").text()).toContain(`v${packageVersion}`);
  });

  it("gibt dem hauptbereich einen programmatisch fokussierbaren skip-link-anker", () => {
    const wrapper = mount(App);

    expect(wrapper.get("#main-content").attributes("tabindex")).toBe("-1");
  });

  it("setzt inert auf die gesamte shell, wenn ein modal aktiv ist", () => {
    // V2: die sperre wird aus dem zustand abgeleitet, nicht vorab gesetzt.
    mockUiState.selectedAppId = 620;
    const wrapper = mount(App);

    expect(mockUiState.inertMain).toBe(true);
    mockUiState.selectedAppId = null;
    expect(wrapper.find(".shell").attributes("inert")).toBeUndefined();
    expect(wrapper.find(".sidebar").attributes("inert")).toBeUndefined();
  });

  it("confirm-dialog setzt inert beim öffnen und räumt beim schließen auf", async () => {
    mockUiState.inertMain = false;
    const wrapper = mount(App);
    await nextTick();
    expect(wrapper.find(".app-background").attributes("inert")).toBeUndefined();

    useConfirmStore().pending = { title: "löschen?" } as never;
    await nextTick();
    expect(mockUiState.inertMain).toBe(true);

    useConfirmStore().pending = null;
    await nextTick();
    expect(mockUiState.inertMain).toBe(false);
  });

  it("verschachtelte dialoge halten die sperre, bis der letzte schliesst (V2)", async () => {
    // V2: drawer offen + erklär-panel offen. Schliesst das panel, bleibt der
    // hintergrund inert, solange der drawer offen ist.
    mockUiState.inertMain = false;
    mount(App);
    await nextTick();

    const ui = useUiStore();
    ui.selectedAppId = 620;
    ui.explanationCount = 1;
    await nextTick();
    expect(mockUiState.inertMain).toBe(true);

    ui.explanationCount = 0;
    await nextTick();
    expect(mockUiState.inertMain).toBe(true);

    ui.selectedAppId = null;
    await nextTick();
    expect(mockUiState.inertMain).toBe(false);
  });
});

describe("App update-hinweis", () => {
  it("zeigt bei neuer version einen schließbaren release-hinweis", async () => {
    mockCheckForUpdate.mockResolvedValue("0.6.11");
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.get(".update-notice").text()).toContain(
      `Protium v0.6.11 ist verfügbar (installiert: v${packageVersion}).`,
    );
    await wrapper.get(".update-close").trigger("click");
    expect(wrapper.find(".update-notice").exists()).toBe(false);
  });

  it("öffnet den release-tag der neuen version", async () => {
    mockCheckForUpdate.mockResolvedValue("0.6.11");
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.get(".update-open").trigger("click");
    expect(mockOpenExternal).toHaveBeenCalledWith(
      "https://github.com/Tzyber/protium-steam-play-proton-manager/releases/tag/v0.6.11",
    );
  });

  it("bleibt bei einem unerwarteten update-check-fehler ohne hinweis", async () => {
    mockCheckForUpdate.mockRejectedValue(new Error("offline"));
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find(".update-notice").exists()).toBe(false);
  });
});
