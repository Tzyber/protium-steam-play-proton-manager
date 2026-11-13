// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NoticeRail from "../../src/ui/components/NoticeRail.vue";
import { declarationValue, flattenCss, ruleBlock } from "../support/cssRules";
import { readRepoFile } from "../support/themeTokens";

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

describe("P5b Gate: NoticeRail & Scroll-Owner je View", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    getMock.mockClear();
  });

  it("App.vue .content ist ein Grid ohne eigenen Scrollbar und bindet <NoticeRail /> ein", () => {
    const app = readRepoFile("src/ui/App.vue");
    expect(app).toMatch(/<NoticeRail\s*\/>/);
    const content = ruleBlock(app, ".content");
    expect(declarationValue(content, "overflow")).toBe("hidden");
    expect(declarationValue(content, "display")).toBe("grid");
    expect(declarationValue(content, "grid-template-rows")).toBe("auto minmax(0, 1fr)");
  });

  it("NoticeRail.vue hält ohne aktive Meldung 0px Höhe und lässt <UpdateNotice /> immer eingehängt", () => {
    const rail = readRepoFile("src/ui/components/NoticeRail.vue");
    expect(rail).toMatch(/<UpdateNotice\s*\/>/);
    expect(rail).not.toMatch(/<UpdateNotice[^>]*v-if/);
    expect(rail).toMatch(/<NotificationToast\s*\/>/);
    const rule = ruleBlock(rail, ".notice-rail");
    expect(declarationValue(rule, "padding")).toBeUndefined();
    expect(declarationValue(rule, "margin")).toBeUndefined();
  });

  it("NotificationToast.vue und UpdateNotice.vue verzichten auf position: sticky (A-08)", () => {
    const toast = readRepoFile("src/ui/components/NotificationToast.vue");
    const toastRule = ruleBlock(toast, ".note.toast");
    expect(declarationValue(toastRule, "position")).toBe("relative");
    expect(flattenCss(toast)).not.toMatch(/position\s*:\s*sticky/);

    const update = readRepoFile("src/ui/components/UpdateNotice.vue");
    const updateRule = ruleBlock(update, ".update-notice");
    expect(declarationValue(updateRule, "position")).toBeUndefined();
    expect(flattenCss(update)).not.toMatch(/position\s*:\s*sticky/);
  });

  it("jede View hat genau einen Scroll-Owner ohne innere Doppel-Scrollbars", () => {
    const lib = ruleBlock(readRepoFile("src/ui/views/LibraryView.vue"), ".library");
    expect(declarationValue(lib, "overflow-y")).toBe("auto");
    expect(declarationValue(lib, "height")).toBe("100%");
    expect(declarationValue(lib, "min-height")).toBe("0");

    const pm = ruleBlock(readRepoFile("src/ui/views/ProtonManagerView.vue"), ".pm");
    expect(declarationValue(pm, "overflow-y")).toBe("auto");
    expect(declarationValue(pm, "height")).toBe("100%");
    expect(declarationValue(pm, "min-height")).toBe("0");

    const cv = readRepoFile("src/ui/views/CleanupView.vue");
    const scroller = ruleBlock(cv, ".scroller");
    expect(declarationValue(scroller, "overflow-y")).toBe("auto");
    expect(declarationValue(ruleBlock(cv, ".actionbar"), "margin")).toBe("0");

    const hv = readRepoFile("src/ui/views/HistoryView.vue");
    expect(hv).not.toMatch(/class="content"/);
    const hvBody = ruleBlock(hv, ".hv-body");
    expect(declarationValue(hvBody, "overflow-y")).toBe("auto");
    expect(declarationValue(ruleBlock(hv, ".entries"), "overflow-y")).toBeUndefined();
    expect(declarationValue(ruleBlock(hv, ".entries"), "max-height")).toBeUndefined();
    expect(declarationValue(ruleBlock(hv, ".log"), "overflow")).toBeUndefined();
    expect(declarationValue(ruleBlock(hv, ".log"), "overflow-y")).toBeUndefined();
  });

  it("NoticeRail führt beim Mount checkForUpdate aus, auch wenn Update/Toast inaktiv sind", async () => {
    const wrapper = mount(NoticeRail);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".update-notice").exists()).toBe(false);
    expect(wrapper.find(".note.toast").exists()).toBe(false);
  });
});
