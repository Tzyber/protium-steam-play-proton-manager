// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { ScanResult } from "../../src/core/types";
import { setLocale, t } from "../../src/ui/i18n";
import { useLibraryStore } from "../../src/ui/stores/libraryStore";
import { useScanStore } from "../../src/ui/stores/scanStore";

function result(overrides: Partial<ScanResult> = {}): ScanResult {
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
    launchConfigStatus: "available",
    manifestCounts: { read: 0, failed: 0 },
    compatToolCounts: { read: 0, failed: 0 },
    steamUserId: null,
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
    blockedAppIds: [],
    ...overrides,
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

  it.each([
    ["de", "scan vollständig · 1 libraries · 2 spiele"],
    ["en", "scan complete · 1 libraries · 2 games"],
  ] as const)("zeigt vollständige coverage lokalisiert (%s)", (locale, label) => {
    setLocale(locale);
    const wrapper = mount(LibraryView);

    expect(wrapper.get(".coverage-summary").text()).toBe(label);
    expect(wrapper.findAll(".coverage-toggle")).toHaveLength(1);
    expect(wrapper.get(".coverage").classes()).toContain("coverage--complete");
    expect(wrapper.find(".coverage-context").exists()).toBe(false);
    expect(wrapper.get(".coverage-toggle").attributes("aria-expanded")).toBe("false");
    expect(wrapper.get(".coverage-toggle").attributes("aria-labelledby")).toBeUndefined();
    expect(wrapper.get(".coverage-toggle").attributes("aria-label")).toBeUndefined();
    expect(wrapper.get(".coverage-toggle").attributes("aria-controls")).toBe(
      "library-coverage-details",
    );
  });

  it("zeigt eine mehrdeutige accountauswahl als eingeschränkt statt vollständig", async () => {
    const scan = useScanStore();
    scan.result = result({
      launchConfigStatus: "ambiguous",
      warnings: [
        {
          type: "launch-config",
          reason: "selection-ambiguous",
          steamUserId: "123",
          detail: "mehrere accounts",
        },
      ],
    });
    const wrapper = mount(LibraryView);

    expect(wrapper.get(".coverage").classes()).toContain("coverage--limited");
    expect(wrapper.get(".coverage-summary").text()).toBe(t("library.coverageLimited"));
    await wrapper.get(".coverage-toggle").trigger("click");
    expect(wrapper.get(".coverage-card:nth-child(2)").classes()).toContain(
      "coverage-card--attention",
    );
  });

  it.each([
    ["de", "scan eingeschränkt · konfiguration prüfen", "zeigt nur den stand dieses lokalen scans"],
    ["en", "scan limited · review configuration", "shows only this local scan"],
  ] as const)("zeigt eingeschränkte coverage lokalisiert (%s)", (locale, label, context) => {
    setLocale(locale);
    const scan = useScanStore();
    scan.result = result({ compatConfigStatus: "missing" });
    const wrapper = mount(LibraryView);

    expect(wrapper.get(".coverage-summary").text()).toBe(label);
    expect(wrapper.get(".coverage").classes()).toContain("coverage--limited");
    expect(wrapper.get(".coverage-context").text()).toBe(context);
    expect(wrapper.find(".coverage-alert").exists()).toBe(true);
    expect(wrapper.get('.coverage [role="status"]').text()).toContain(label);
  });

  it.each([
    ["de", "scan unvollständig · details prüfen", "zeigt nur den stand dieses lokalen scans"],
    ["en", "scan incomplete · review details", "shows only this local scan"],
  ] as const)("zeigt unvollständige coverage lokalisiert (%s)", (locale, label, context) => {
    setLocale(locale);
    const scan = useScanStore();
    scan.result = result({ manifestCounts: { read: 1, failed: 1 } });
    const wrapper = mount(LibraryView);

    expect(wrapper.get(".coverage-summary").text()).toBe(label);
    expect(wrapper.get(".coverage").classes()).toContain("coverage--incomplete");
    expect(wrapper.get(".coverage-context").text()).toBe(context);
    expect(wrapper.find(".coverage-alert").exists()).toBe(true);
    expect(wrapper.get('.coverage [role="status"]').text()).toContain(label);
  });

  it("öffnet einen einzigen gruppierten detailbereich mit typisierten fakten", async () => {
    const scan = useScanStore();
    scan.result = result({
      libraries: ["/home/u/.steam", "/mnt/games"],
      skippedLibraries: [{ path: "/mnt/games", reason: "path-missing" }],
      warnings: [
        {
          type: "library",
          path: "/mnt/games",
          reason: "path-missing",
          detail: "steamapps fehlt",
        },
        {
          type: "manifest",
          library: "/home/u/.steam",
          manifestName: "appmanifest_42.acf",
          reason: "invalid-content",
          detail: "VDF defekt",
        },
        {
          type: "compat-tool",
          directory: "/home/u/.steam/compatibilitytools.d",
          toolName: "Broken-Proton",
          reason: "vdf-invalid",
          detail: "VDF defekt",
        },
      ],
      manifestCounts: { read: 1, failed: 1 },
      compatToolCounts: { read: 0, failed: 1 },
    });
    const wrapper = mount(LibraryView);
    const button = wrapper.get(".coverage-toggle");

    await nextTick();
    expect(wrapper.get("#library-coverage-details").attributes("style")).toContain("display: none");
    await button.trigger("click");

    expect(button.attributes("aria-expanded")).toBe("true");
    expect(button.attributes("aria-labelledby")).toBeUndefined();
    expect(wrapper.findAll(".coverage-details")).toHaveLength(1);
    expect(wrapper.get("#library-coverage-details").attributes("role")).toBe("region");
    expect(wrapper.get("#library-coverage-details").attributes("aria-labelledby")).toBe(
      "library-coverage-title",
    );
    expect(wrapper.get("#library-coverage-details").attributes("style")).toBeUndefined();
    expect(wrapper.find(".coverage-details").text()).toContain("/mnt/games");
    expect(wrapper.find(".coverage-details").text()).not.toContain("read: /mnt/games");
    expect(wrapper.find(".coverage-details").text()).toContain("appmanifest_42.acf");
    expect(wrapper.find(".coverage-details").text()).toContain("Broken-Proton");
    expect(wrapper.findAll(".coverage-card")).toHaveLength(4);
    expect(wrapper.find(".coverage-card").classes()).toContain("coverage-card--attention");
    expect(wrapper.findAll(".coverage-card--attention")).toHaveLength(3);
    expect(wrapper.findAll(".coverage-card--complete")).toHaveLength(1);
    expect(wrapper.get(".coverage-chevron").text()).toBe("⌃");
    expect(wrapper.find(".warnings").exists()).toBe(false);

    await button.trigger("click");
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(wrapper.get(".coverage-chevron").text()).toBe("⌄");
    expect(wrapper.find("#library-coverage-details").exists()).toBe(true);
    expect(wrapper.get("#library-coverage-details").attributes("style")).toContain("display: none");
  });

  it("zeigt eine übersprungene library mit warning nicht als gelesen", async () => {
    const scan = useScanStore();
    scan.result = result({
      libraries: ["/mnt/games"],
      skippedLibraries: [{ path: "/mnt/games", reason: "read-failed" }],
      warnings: [
        {
          type: "library",
          path: "/mnt/games",
          reason: "read-failed",
          detail: "permission denied",
        },
      ],
    });
    const wrapper = mount(LibraryView);

    await wrapper.get(".coverage-toggle").trigger("click");

    const details = wrapper.get(".coverage-details").text();
    expect(details).toContain("unavailable: /mnt/games");
    expect(details).not.toContain("read: /mnt/games");
  });

  it.each(["scanning", "error"] as const)("zeigt bei status %s keine coverage", (status) => {
    const scan = useScanStore();
    scan.status = status;
    const wrapper = mount(LibraryView);

    expect(wrapper.find(".coverage-summary").exists()).toBe(false);
    expect(wrapper.find(".coverage-toggle").exists()).toBe(false);
  });
});
