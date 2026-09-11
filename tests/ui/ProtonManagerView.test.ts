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
    defaultCompatTool: null as string | null,
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
  protonState.defaultCompatTool = null;
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
    expect(dialog?.textContent).toContain("compatdata-Prefixes der Spiele bleiben unberührt");
    expect(dialog?.textContent).toContain("bedeutet nicht, dass das Tool ungenutzt ist");
    wrapper.unmount();
  });
});

describe("globaler standard", () => {
  it("markiert das tool mit dem globalen standard und springt auf den literalfilter", async () => {
    setLocale("de");
    uiState.showLibraryForTool.mockClear();
    protonState.installedTools = [
      makeInstalledTool("GE-Proton9-27"),
      makeInstalledTool("GE-Proton10-1"),
    ];
    protonState.defaultCompatTool = "GE-Proton9-27";

    const wrapper = mount(ProtonManagerView);
    const button = wrapper.get('[data-testid="global-default"]');
    expect(wrapper.findAll('[data-testid="global-default"]')).toHaveLength(1);
    expect(button.element.closest("li")?.textContent).toContain("GE-Proton9-27");
    expect(button.text()).toBe("globaler standard in steams config →");

    await button.trigger("click");
    expect(uiState.showLibraryForTool).toHaveBeenCalledWith("default");

    wrapper.unmount();
  });
});
