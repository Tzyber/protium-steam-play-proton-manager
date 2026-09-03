// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScanResult } from "../../src/core/types";
import FilterBar from "../../src/ui/components/FilterBar.vue";
import { setLocale, t } from "../../src/ui/i18n";
import { useLibraryStore } from "../../src/ui/stores/libraryStore";
import { useScanStore } from "../../src/ui/stores/scanStore";

function result(): ScanResult {
  return {
    steamRoot: "/home/u/.steam",
    libraries: ["/home/u/.steam"],
    games: [
      {
        appId: 42,
        name: "Game 42",
        library: "/home/u/.steam",
        sizeBytes: 100,
        compatTool: "default",
        compatToolSource: "default",
        protonDb: { tier: "bronze", confidence: "strong" },
        localHeader: null,
        headerImage: null,
      },
    ],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: "proton_experimental",
    compatConfigStatus: "available",
    launchConfigStatus: "available",
    manifestCounts: { read: 0, failed: 0 },
    compatToolCounts: { read: 0, failed: 0 },
    steamUserId: null,
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
    blockedAppIds: [],
  };
}

describe("FilterBar proton-check", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("en");
    useScanStore().result = result();
  });

  afterEach(() => setLocale("en"));

  it("zeigt einen zugänglichen proton-check-button mit pressed-state", async () => {
    const wrapper = mount(FilterBar);
    const button = wrapper.get("button.proton-check");

    expect(button.attributes("aria-label")).toBe(t("filter.protonCheckAria"));
    expect(button.attributes("aria-pressed")).toBe("false");
    expect(button.text()).toContain(t("filter.protonCheck"));

    await button.trigger("click");

    expect(button.attributes("aria-pressed")).toBe("true");
    expect(useLibraryStore().protonCheck).toBe(true);
  });

  it("zeigt die beschriftete suche und leert sie über den clear-button", async () => {
    const lib = useLibraryStore();
    const wrapper = mount(FilterBar);
    const input = wrapper.get("input#library-search");

    expect(wrapper.get('label[for="library-search"]').text()).toBe(t("filter.search"));

    await input.setValue("test");

    const clear = wrapper.get("button.clear");
    expect(clear.attributes("aria-label")).toBe(t("filter.searchClear"));

    await clear.trigger("click");

    expect(lib.search).toBe("");
    expect(wrapper.find("button.clear").exists()).toBe(false);
  });

  it("reset setzt den aktiven proton-check zurück", async () => {
    const lib = useLibraryStore();
    lib.protonCheck = true;
    const wrapper = mount(FilterBar);

    await wrapper.get("button.reset").trigger("click");

    expect(lib.protonCheck).toBe(false);
    expect(wrapper.get("button.proton-check").attributes("aria-pressed")).toBe("false");
  });
});
