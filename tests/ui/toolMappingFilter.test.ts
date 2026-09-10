// @vitest-environment happy-dom

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanLocal } from "../../src/core/scan/local";
import type { ScanResult } from "../../src/core/types";
import { setLocale, t } from "../../src/ui/i18n";
import { useLibraryStore } from "../../src/ui/stores/libraryStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { buildFakeSteam, fakeHttp, fakeSystem, memCache, nodeFs } from "../support/fakeSteam";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

vi.mock("../../src/ui/components/FilterBar.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../../src/ui/components/GameDetailDrawer.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("../../src/ui/components/GameCard.vue", () => ({
  default: {
    props: ["game"],
    template: '<article class="mock-card">{{ game.name }}</article>',
  },
}));

import LibraryView from "../../src/ui/views/LibraryView.vue";
import ProtonManagerView from "../../src/ui/views/ProtonManagerView.vue";

// interner manifestname weicht vom verzeichnisnamen ab (umbenannter ordner,
// nachbearbeitetes manifest). das mapping kann nur den internen namen nennen.
const TOOL_DIR = "CustomProton Folder";
const TOOL_INTERNAL = "CustomProton-internal";

/** fixture mit divergentem tool plus optionaler verzeichnisnamen-zuordnung. */
async function scanWithDivergentTool(dirNameMapping: boolean) {
  const fixture = await buildFakeSteam();
  await mkdir(join(fixture.systemCompat, TOOL_DIR), { recursive: true });
  await writeFile(
    join(fixture.systemCompat, TOOL_DIR, "compatibilitytool.vdf"),
    `"compatibilitytools"
{
	"compat_tools"
	{
		"${TOOL_INTERNAL}"
		{
			"display_name"		"Custom Proton"
		}
	}
}
`,
  );
  const configPath = join(fixture.root, "config", "config.vdf");
  const config = await readFile(configPath, "utf8");
  const mapping = config.replace('"GE-Proton9-27"', `"${TOOL_INTERNAL}"`);
  // 730 zeigt auf den verzeichnisnamen: als scannendes tool existiert dieses
  // ziel nicht (kein tool namens "… Folder"), die zuordnung ist damit stale.
  await writeFile(
    configPath,
    dirNameMapping
      ? mapping.replace(/("730"\s*\{\s*"name"\s*)"proton-cachyos-slr"/, `$1"${TOOL_DIR}"`)
      : mapping,
  );

  return scanLocal(
    { fs: nodeFs(), http: fakeHttp(), system: fakeSystem(), cache: memCache() },
    fixture.environment,
  );
}

function installScanResult(result: Awaited<ReturnType<typeof scanWithDivergentTool>>): void {
  const scan = useScanStore();
  const full: ScanResult = { steamRoot: "/fake/steam", ...result };
  scan.result = full;
  scan.status = "done";
  scan.statusText = t("status.ready");
}

describe("Zuordnungszähler gegen library-filter", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    useLibraryStore().reset();
  });

  afterEach(() => {
    setLocale("de");
    document.body.innerHTML = "";
  });

  it("zeigt nach dem klick genau die gezählten spiele bei abweichendem verzeichnisnamen", async () => {
    const result = await scanWithDivergentTool(false);
    installScanResult(result);

    const tool = result.compatToolsInstalled.find((candidate) => candidate.name === TOOL_DIR);
    if (!tool) throw new Error("divergentes tool fehlt im scan");
    expect(tool.internalName).toBe(TOOL_INTERNAL);
    // der scan trägt den internen namen: kein spiel nennt den verzeichnisnamen
    expect(result.games.filter((game) => game.compatTool === TOOL_DIR)).toEqual([]);
    expect(result.games.find((game) => game.appId === 620)?.compatTool).toBe(TOOL_INTERNAL);
    expect(tool.usedBy).toEqual([620]);

    const manager = mount(ProtonManagerView);
    const library = mount(LibraryView);
    await library.vm.$nextTick();

    expect(library.findAll(".grid-item")).toHaveLength(result.games.length);

    const usedButton = manager.get("button.used");
    expect(usedButton.text()).toBe(t("proton.usedBy", { n: tool.usedBy.length }));

    await usedButton.trigger("click");
    await library.vm.$nextTick();

    const shown = library.findAll(".grid-item");
    expect(shown).toHaveLength(tool.usedBy.length);
    expect(shown.map((item) => item.text())).toEqual(
      tool.usedBy.map((appId) => result.games.find((game) => game.appId === appId)?.name),
    );
    expect(shown.map((item) => item.text())).toEqual(["Portal 2"]);
  });

  it("zählt eine stale zuordnung über den verzeichnisnamen nicht mit", async () => {
    const result = await scanWithDivergentTool(true);
    installScanResult(result);

    const tool = result.compatToolsInstalled.find((candidate) => candidate.name === TOOL_DIR);
    if (!tool) throw new Error("divergentes tool fehlt im scan");
    // die zuordnung von 730 auf den verzeichnisnamen bleibt im spielstand sichtbar,
    // sie zeigt aber auf kein installiertes tool.
    expect(result.games.find((game) => game.appId === 730)?.compatTool).toBe(TOOL_DIR);
    expect(result.games.filter((game) => game.compatTool === TOOL_INTERNAL)).toHaveLength(1);
    expect(tool.usedBy).toEqual([620]);

    const manager = mount(ProtonManagerView);
    const library = mount(LibraryView);
    await library.vm.$nextTick();

    const usedButton = manager.get("button.used");
    expect(usedButton.text()).toBe(t("proton.usedBy", { n: 1 }));

    await usedButton.trigger("click");
    await library.vm.$nextTick();

    expect(library.findAll(".grid-item").map((item) => item.text())).toEqual(["Portal 2"]);
    // die trefferzahl der library deckt sich mit der zugesagten zahl am knopf
    expect(library.get(".title h1").text()).toContain(String(tool.usedBy.length));
  });
});
