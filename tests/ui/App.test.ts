// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
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
  t: (key: string) => key,
}));
vi.mock("../../src/ui/stores/scanStore", () => ({
  useScanStore: () => mockScanState,
}));
vi.mock("../../src/ui/stores/uiStore", () => ({
  useUiStore: () => mockUiState,
}));

import App from "../../src/ui/App.vue";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  document.body.innerHTML = "";
  mockScanState.runScan.mockClear();
  mockUiState.inertMain = true;
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
