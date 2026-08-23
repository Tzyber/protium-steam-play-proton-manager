// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { ScanResult } from "../../src/core/types";
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
        name: "Needs Check",
        library: "/home/u/.steam",
        sizeBytes: 100,
        compatTool: "default",
        compatToolSource: "default",
        protonDb: { tier: "bronze", confidence: "strong" },
        localHeader: null,
        headerImage: null,
      },
      {
        appId: 43,
        name: "Clean Game",
        library: "/home/u/.steam",
        sizeBytes: 50,
        compatTool: "default",
        compatToolSource: "default",
        protonDb: { tier: "gold", confidence: "strong" },
        localHeader: null,
        headerImage: null,
      },
    ],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: "proton_experimental",
    compatConfigStatus: "available",
    steamUserId: null,
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
  };
}

// Die View-Tests fokussieren Filterung und Nachlaufstatus; die Kindflächen
// werden deshalb auf ihre übergebenen Daten reduziert.
vi.mock("../../src/ui/components/FilterBar.vue", () => ({
  default: { template: '<div data-testid="filter-bar" />' },
}));
vi.mock("../../src/ui/components/GameDetailDrawer.vue", () => ({
  default: { template: '<div data-testid="game-drawer" />' },
}));
vi.mock("../../src/ui/components/GameCard.vue", () => ({
  default: {
    props: ["game"],
    template: '<article class="mock-card">{{ game.name }}</article>',
  },
}));

import LibraryView from "../../src/ui/views/LibraryView.vue";

describe("LibraryView proton-check und ProtonDB-Nachlauf", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("en");
    const scan = useScanStore();
    scan.result = result();
    scan.status = "done";
    scan.statusText = t("status.ready");
    scan.protonDbRemaining = 2;
  });

  afterEach(() => setLocale("en"));

  it("zeigt lokale Karten und live Reststatus ohne globales aria-busy", async () => {
    const wrapper = mount(LibraryView);
    const scan = useScanStore();

    expect(wrapper.findAll(".mock-card")).toHaveLength(2);
    expect(wrapper.find("ul.grid").attributes("aria-busy")).toBeUndefined();
    expect(wrapper.get(".status").text()).toBe(t("library.protonDbRemaining", { n: 2 }));
    expect(wrapper.get("button.rescan").attributes("disabled")).toBeUndefined();

    scan.protonDbRemaining = 1;
    await nextTick();
    expect(wrapper.get(".status").text()).toBe(t("library.protonDbRemaining", { n: 1 }));

    scan.protonDbRemaining = 0;
    await nextTick();
    expect(wrapper.get(".status").text()).toBe(t("status.ready"));
  });

  it("zeigt mit aktivem proton-check nur abgeleitete treffer", () => {
    const lib = useLibraryStore();
    lib.protonCheck = true;

    const wrapper = mount(LibraryView);

    expect(wrapper.findAll(".mock-card").map((card) => card.text())).toEqual(["Needs Check"]);
  });
});
