// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NoticeRail from "../../src/ui/components/NoticeRail.vue";

const getMock = vi.fn().mockResolvedValue({ status: 200, body: "[]" });

vi.mock("../../src/core/adapters/tauri", () => ({
  tauriPorts: {
    http: {
      get: (...args: unknown[]) => getMock(...args),
    },
    system: {
      openExternal: vi.fn(),
    },
  },
}));

describe("NoticeRail", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    getMock.mockClear();
  });

  it("führt beim Mount checkForUpdate aus, auch wenn Update/Toast inaktiv sind", async () => {
    const wrapper = mount(NoticeRail);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".update-notice").exists()).toBe(false);
    expect(wrapper.find(".note.toast").exists()).toBe(false);
  });
});
