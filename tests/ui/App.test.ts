// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  document.body.innerHTML = "";
  mockScanState.runScan.mockClear();
});

describe("App modal background", () => {
  it("setzt inert auf die gesamte shell, wenn ein modal aktiv ist", () => {
    const wrapper = mount(App);

    expect(wrapper.find(".app-background").attributes("inert")).toBeDefined();
    expect(wrapper.find(".shell").attributes("inert")).toBeUndefined();
    expect(wrapper.find(".sidebar").attributes("inert")).toBeUndefined();
  });
});
