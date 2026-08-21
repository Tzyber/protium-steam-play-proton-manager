// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeRelease } from "../../src/core/geproton";
import type { CompatTool } from "../../src/core/types";

const { protonState, scanState, uiState } = vi.hoisted(() => ({
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
    showLibraryForTool: vi.fn(),
  },
}));

vi.mock("../../src/ui/stores/protonStore", () => ({
  useProtonStore: () => protonState,
}));
vi.mock("../../src/ui/stores/scanStore", () => ({
  useScanStore: () => scanState,
}));
vi.mock("../../src/ui/stores/uiStore", () => ({
  useUiStore: () => uiState,
}));
vi.mock("../../src/ui/i18n", () => ({
  t: (key: string) => key,
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
});
