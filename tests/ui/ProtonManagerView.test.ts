// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import type { GeRelease } from "../../src/core/geproton";
import type { CompatTool } from "../../src/core/types";
import { setLocale } from "../../src/ui/i18n";
import { useProtonStore } from "../../src/ui/stores/protonStore";

const { protonState, scanState, uiState, confirmState } = vi.hoisted(() => ({
  protonState: {
    installedTools: [] as CompatTool[],
    releases: [] as GeRelease[],
    loading: false,
    loadError: null as string | null,
    lastFetchedAt: null as number | null,
    lastSource: null,
    jobs: {},
    activeTag: null as string | null,
    busyRemove: null as string | null,
    warning: null,
    init: vi.fn(async () => {}),
    loadReleases: vi.fn(async () => {}),
    clearWarning: vi.fn(),
    queueInstall: vi.fn(),
    cancel: vi.fn(async () => {}),
    remove: vi.fn(),
  },
  scanState: {
    games: [],
  },
  uiState: {
    inertMain: false,
    explanationCount: 0,
    openExplanation: vi.fn(),
    closeExplanation: vi.fn(),
    showLibraryForTool: vi.fn(),
  },
  confirmState: {
    pending: null,
    reserved: false,
    busy: false,
    error: null,
    ask: vi.fn(),
    cancel: vi.fn(),
    confirm: vi.fn(),
  },
}));

vi.mock("../../src/ui/stores/protonStore", () => ({
  useProtonStore: () => reactive(protonState),
}));
vi.mock("../../src/ui/stores/scanStore", () => ({
  useScanStore: () => scanState,
}));
vi.mock("../../src/ui/stores/uiStore", () => ({
  useUiStore: () => uiState,
}));
vi.mock("../../src/ui/stores/confirmStore", () => ({
  useConfirmStore: () => confirmState,
}));

import ProtonManagerView from "../../src/ui/views/ProtonManagerView.vue";

function makeRelease(tag: string, installName: string): GeRelease {
  return {
    tag,
    name: tag,
    publishedAt: "",
    notes: "",
    installName,
    tarball: {
      name: `${installName}.tar.gz`,
      url: `https://github.com/GloriousEggroll/proton-ge-custom/releases/download/${tag}/${installName}.tar.gz`,
      size: 508 * 1024 * 1024,
    },
    sha512Url: null,
  };
}

function makeInstalledTool(name: string): CompatTool {
  return {
    name,
    internalName: name,
    displayName: name,
    sizeBytes: 1,
    usedBy: [],
    source: "user",
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ProtonManagerView release install status", () => {
  it.each([
    {
      label: "modern x86_64 asset",
      tag: "GE-Proton11-5",
      installName: "GE-Proton11-5-x86_64",
    },
    {
      label: "legacy asset",
      tag: "GE-Proton9-27",
      installName: "GE-Proton9-27",
    },
  ])("markiert $label als installiert", ({ tag, installName }) => {
    protonState.installedTools = [makeInstalledTool(installName)];
    protonState.releases = [makeRelease(tag, installName)];

    const wrapper = mount(ProtonManagerView);
    const lists = wrapper.findAll("ul.list");
    expect(lists).toHaveLength(2);
    const releaseList = lists[1];
    if (releaseList === undefined) throw new Error("release list fehlt");
    const releaseRow = releaseList.find("li");

    expect(releaseRow.text()).toContain(tag);
    expect(releaseRow.find(".tag.ok").exists()).toBe(true);
    expect(releaseRow.find(".install").exists()).toBe(false);
  });

  it("gibt jedem Sperrgrund eine eigene id und zeigt ihn nur am entfernbaren Knopf", () => {
    // mehrere gesperrte Zeilen dürfen keine doppelte id erzeugen
    protonState.installedTools = [
      makeInstalledTool("GE-Proton9-27"),
      makeInstalledTool("GE-Proton10-1"),
      { ...makeInstalledTool("proton_9"), source: "system" as const },
    ];
    confirmState.reserved = true;

    const wrapper = mount(ProtonManagerView);
    const reasons = wrapper
      .findAll("span.sr-only")
      .filter((span) => span.attributes("id") !== undefined);
    const ids = reasons.map((span) => span.attributes("id"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    // jede beschreibung zeigt auf einen vorhandenen grund
    const described = wrapper
      .findAll("button.rm")
      .map((button) => button.attributes("aria-describedby"));
    expect(described.every((value) => value !== undefined && ids.includes(value))).toBe(true);

    // das nicht entfernbare tool trägt das Schloss, nicht die Begründung
    const installedRow = wrapper.findAll("ul.list")[0]?.findAll("li").at(-1);
    if (!installedRow) throw new Error("zeile fehlt");
    const notManageable = installedRow;
    expect(notManageable.find(".rm-lock").exists()).toBe(true);
    expect(notManageable.find("button.rm").exists()).toBe(false);
  });

  it("sperrt alle GE-entfernungen bei einer offenen dialog-reservierung", () => {
    protonState.installedTools = [
      makeInstalledTool("GE-Proton9-27"),
      makeInstalledTool("GE-Proton10-1"),
    ];
    confirmState.reserved = true;

    const wrapper = mount(ProtonManagerView);
    const removeButtons = wrapper.findAll("button.rm");

    expect(removeButtons).toHaveLength(2);
    expect(removeButtons.every((button) => button.attributes("disabled") !== undefined)).toBe(true);
  });
});

describe("bekannte explizite Zuordnungen", () => {
  it.each([
    { sizes: [], expected: "0 · 0 B" },
    { sizes: [1024], expected: "1 · 1.0 KB" },
    { sizes: [1024, 2048], expected: "2 · 3.0 KB" },
    { sizes: [1024, undefined], expected: "2 · 1.0 KB" },
    { sizes: [undefined], expected: "1 · nicht gemessen" },
    { sizes: [0], expected: "1 · 0 B" },
  ])("summiert nur zugeordnete Tools: $expected", ({ sizes, expected }) => {
    setLocale("de");
    protonState.installedTools = sizes.map((sizeBytes, i) => ({
      ...makeInstalledTool(`GE-Proton9-${i + 1}`),
      sizeBytes,
      usedBy: [620],
    }));
    protonState.installedTools.push({ ...makeInstalledTool("GE-Proton9-99"), sizeBytes: 99999 });
    const wrapper = mount(ProtonManagerView);
    const text = wrapper.get('[data-testid="mapping-summary"]').text();
    expect(text).toContain(expected);
    expect(text.includes("teilweise")).toBe(
      sizes.some((size) => size === undefined) && sizes.some((size) => size !== undefined),
    );
    wrapper.unmount();
  });

  it("aktualisiert die Zusammenfassung aus bestehenden usedBy-Werten", async () => {
    protonState.installedTools = [makeInstalledTool("GE-Proton9-27")];
    const wrapper = mount(ProtonManagerView);
    expect(wrapper.get('[data-testid="mapping-summary"]').text()).toContain("0 · 0 B");
    const tool = useProtonStore().installedTools[0];
    if (!tool) throw new Error("tool fehlt");
    tool.usedBy = [620, 570];
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="mapping-summary"]').text()).toContain("1 · 1 B");
    wrapper.unmount();
  });

  it("erklärt Quelle und Löschumfang neben der unveränderten Überschrift", async () => {
    setLocale("de");
    protonState.installedTools = [
      { ...makeInstalledTool("GE-Proton9-27"), usedBy: [620], source: "system" },
    ];
    const wrapper = mount(ProtonManagerView, { attachTo: document.body });
    expect(wrapper.get("h3").text()).toBe("installiert 1");
    expect(wrapper.get("h3").find("button").exists()).toBe(false);
    expect(wrapper.get(".used").attributes("title")).toBeUndefined();
    expect(wrapper.find("button.rm").exists()).toBe(false);
    const trigger = wrapper.get('[data-testid="explain-trigger"]');
    expect(trigger.attributes("aria-label")).toContain("installiert");
    expect(trigger.attributes("tabindex")).not.toBe("-1");
    await trigger.trigger("click");
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("CompatToolMapping");
    expect(dialog?.textContent).toContain("globaler Standard");
    expect(dialog?.textContent).toContain("Prefix-Ordner der Spiele bleiben");
    wrapper.unmount();
  });
});

describe("ProtonManagerView downloadfortschritt", () => {
  // U-06: ohne bekannte gesamtgröße gibt es keinen echten wert, deshalb läuft
  // der balken indeterminiert statt einen erfundenen füllstand (früher 30 %)
  // vorzutäuschen.
  it("zeigt bei unbekanntem total einen indeterminierten balken ohne prozentwert", () => {
    setLocale("de");
    protonState.releases = [makeRelease("GE-Proton11-5", "GE-Proton11-5-x86_64")];
    protonState.jobs = {
      "GE-Proton11-5": {
        tag: "GE-Proton11-5",
        downloadId: "d1",
        phase: "downloading",
        downloaded: 0,
        total: null,
      },
    };

    const wrapper = mount(ProtonManagerView);
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.find(".fill").classes()).toContain("fill--indeterminate");
    expect(bar.attributes("aria-valuenow")).toBeUndefined();
    expect(bar.text()).not.toContain("%");
    expect(bar.text()).not.toContain("30");
    wrapper.unmount();
  });

  it("rendert bei bekanntem total einen echten wert als scaleX und aria-valuenow", () => {
    setLocale("de");
    protonState.releases = [makeRelease("GE-Proton11-5", "GE-Proton11-5-x86_64")];
    protonState.jobs = {
      "GE-Proton11-5": {
        tag: "GE-Proton11-5",
        downloadId: "d1",
        phase: "downloading",
        downloaded: 30,
        total: 100,
      },
    };

    const wrapper = mount(ProtonManagerView);
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes("aria-valuenow")).toBe("30");
    const fill = bar.get(".fill");
    expect(fill.classes()).not.toContain("fill--indeterminate");
    expect(fill.attributes("style")).toContain("scaleX(0.3)");
    expect(bar.text()).toContain("30%");
    wrapper.unmount();
  });
});
