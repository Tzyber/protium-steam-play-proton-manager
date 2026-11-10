// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCheckForUpdate = vi.hoisted(() => vi.fn());
const mockOpenExternal = vi.hoisted(() => vi.fn());

vi.mock("../../src/core/update", () => ({
  checkForUpdate: mockCheckForUpdate,
  UPDATE_RELEASE_URL: "https://github.com/Tzyber/protium-steam-play-proton-manager/releases",
}));
vi.mock("../../src/core/adapters/tauri", () => ({
  openExternal: mockOpenExternal,
  tauriPorts: { http: {} },
}));

import UpdateNotice from "../../src/ui/components/UpdateNotice.vue";

beforeEach(() => {
  setActivePinia(createPinia());
  mockCheckForUpdate.mockResolvedValue("9.9.9");
  mockOpenExternal.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  mockCheckForUpdate.mockReset();
  mockOpenExternal.mockReset();
});

describe("UpdateNotice live-region (4.18)", () => {
  it("trägt die status-rolle am text, nicht am container mit den knöpfen", async () => {
    const wrapper = mount(UpdateNotice);
    await flushPromises();

    const section = wrapper.get(".update-notice");
    expect(section.element.tagName).toBe("SECTION");
    expect(section.attributes("role")).toBeUndefined();

    const status = wrapper.findAll('[role="status"]');
    expect(status).toHaveLength(1);
    const message = status[0];
    if (message === undefined) throw new Error("status-span fehlt");
    expect(message.element.tagName).toBe("SPAN");
    // die knöpfe stehen neben der live-region, nicht darin
    expect(message.findAll("button")).toHaveLength(0);
    expect(wrapper.findAll("button")).toHaveLength(2);

    wrapper.unmount();
  });

  it("ohne neue version bleibt der hinweis aus", async () => {
    mockCheckForUpdate.mockResolvedValue(null);
    const wrapper = mount(UpdateNotice);
    await flushPromises();

    expect(wrapper.find(".update-notice").exists()).toBe(false);

    wrapper.unmount();
  });
});
