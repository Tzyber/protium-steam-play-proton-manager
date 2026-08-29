// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { version as packageVersion } from "../../package.json";

const mockUiState = vi.hoisted(() => ({
  activeView: "library",
  inertMain: true,
  notification: null,
  dismissNotification: vi.fn(),
}));
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
    key === "app.updateAvailable" ? `Protium v${params?.version} ist verfügbar.` : key,
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

  it("setzt inert auf die gesamte shell, wenn ein modal aktiv ist", () => {
    const wrapper = mount(App);

    expect(wrapper.find(".app-background").attributes("inert")).toBeDefined();
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
});

describe("App update-hinweis", () => {
  it("zeigt bei neuer version einen schließbaren release-hinweis", async () => {
    mockCheckForUpdate.mockResolvedValue("0.6.11");
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.get(".update-notice").text()).toContain("Protium v0.6.11 ist verfügbar.");
    await wrapper.get(".update-close").trigger("click");
    expect(wrapper.find(".update-notice").exists()).toBe(false);
  });

  it("öffnet nur die feste release-seite", async () => {
    mockCheckForUpdate.mockResolvedValue("0.6.11");
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.get(".update-open").trigger("click");
    expect(mockOpenExternal).toHaveBeenCalledWith(
      "https://github.com/Tzyber/protium-steam-play-proton-manager/releases",
    );
  });

  it("bleibt bei einem unerwarteten update-check-fehler ohne hinweis", async () => {
    mockCheckForUpdate.mockRejectedValue(new Error("offline"));
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find(".update-notice").exists()).toBe(false);
  });
});
