// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import ScanCoveragePanel from "../../src/ui/components/ScanCoveragePanel.vue";
import { formatLibraryReason } from "../../src/ui/coverageText";
import { setLocale, t } from "../../src/ui/i18n";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { scanResult } from "../support/factories";
import { readRepoFile } from "../support/themeTokens";

/** P17a/FR-2 (4.14): die vier Karten kommen aus einer computed-Gruppenliste.
 *  Texte, Reihenfolge und Aufmerksamkeits-Markierung bleiben wie zuvor. */
function seedScan(): void {
  const scan = useScanStore();
  scan.result = scanResult({
    libraries: ["/home/u/.steam"],
    skippedLibraries: [{ path: "/mnt/games", reason: "path-missing" }],
    compatConfigStatus: "missing",
    launchConfigStatus: "available",
    manifestCounts: { read: 2, failed: 1 },
    compatToolCounts: { read: 1, failed: 0 },
    warnings: [
      {
        type: "manifest",
        library: "/home/u/.steam",
        manifestName: "appmanifest_42.acf",
        reason: "unreadable",
      },
    ],
  });
  scan.status = "done";
}

async function mountOpen() {
  const wrapper = mount(ScanCoveragePanel);
  await wrapper.get(".coverage-toggle").trigger("click");
  return wrapper;
}

describe("ScanCoveragePanel: Karten aus der Gruppenliste", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("en");
    seedScan();
  });

  it("rendert die vier Karten in fester Reihenfolge", async () => {
    const wrapper = await mountOpen();
    const cards = wrapper.findAll(".coverage-card");
    expect(cards).toHaveLength(4);
    expect(cards.map((card) => card.get("h2").text())).toEqual([
      t("library.coverageLibraries"),
      t("library.coverageConfiguration"),
      t("library.coverageManifests"),
      t("library.coverageTools"),
    ]);
  });

  it("zeigt die Zusammenfassungen und Zeilen der Gruppen", async () => {
    const wrapper = await mountOpen();
    const [libraries, configuration, manifests, tools] = wrapper.findAll(".coverage-card");

    expect(libraries?.get(".coverage-card-summary").text()).toBe(
      t("library.coverageLibrariesSummary", { read: 1, unavailable: 1 }),
    );
    expect(libraries?.text()).toContain(
      t("library.coverageLibraryUnavailable", { path: "/mnt/games" }),
    );
    expect(libraries?.text()).toContain(formatLibraryReason("path-missing"));

    expect(configuration?.get(".coverage-card-summary").text()).toBe(
      t("library.coverageConfigStatus", {
        source: t("library.coverageCompatConfig"),
        status: t("library.coverageStatusMissing"),
      }),
    );
    expect(configuration?.text()).toContain(
      t("library.coverageConfigStatus", {
        source: t("library.coverageLaunchConfig"),
        status: t("library.coverageStatusAvailable"),
      }),
    );

    expect(manifests?.get(".coverage-card-summary").text()).toBe(
      t("library.coverageCounts", { read: 2, failed: 1 }),
    );
    expect(tools?.get(".coverage-card-summary").text()).toBe(
      t("library.coverageCounts", { read: 1, failed: 0 }),
    );

    expect(manifests?.findAll("li").map((item) => item.text())).toEqual([
      t("library.coverageWarningManifest", {
        name: "appmanifest_42.acf",
        reason: t("library.coverageReasonUnreadable"),
      }),
    ]);
  });

  it("markiert Aufmerksamkeit je Gruppe (fehlende Konfiguration, Bibliothek, Manifest)", async () => {
    const wrapper = await mountOpen();
    expect(wrapper.findAll(".coverage-card--attention")).toHaveLength(3);
    expect(wrapper.findAll(".coverage-card--complete")).toHaveLength(1);
    expect(wrapper.get(".coverage-card").classes()).toContain("coverage-card--attention");
  });

  it("leitet die Karten aus einer computed-Gruppenliste per v-for ab", () => {
    const source = readRepoFile("src/ui/components/ScanCoveragePanel.vue");
    expect(source).toContain("const coverageCards = computed");
    expect(source).toContain('v-for="card in coverageCards"');
    // genau eine karten-markup-stelle statt vier fester blöcke
    expect(source.match(/class="coverage-group coverage-card"/g) ?? []).toHaveLength(1);
  });
});
