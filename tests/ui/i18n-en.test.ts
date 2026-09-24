import { describe, expect, it } from "vitest";
import { setLocale, t } from "../../src/ui/i18n";

describe("i18n, locale-wechsel per setLocale (regression: englische UI rendert)", () => {
  it("nach setLocale('en') liefert t() englische strings", () => {
    setLocale("en");
    expect(t("common.cancel")).toBe("cancel");
    expect(t("common.delete")).toBe("delete");
    expect(t("cleanup.orphanedData")).toBe("orphaned data");
    expect(t("cleanup.searchButton")).toBe("scan for orphaned data");
    expect(t("proton.refreshReleases")).toBe("refresh releases");
    expect(t("drawer.play")).toBe("start game");
    expect(t("filter.sortSize")).toBe("size");
    expect(t("status.ready")).toBe("ready");
    expect(t("errors.codes.steamRunning")).toMatch(/Steam is currently running/);
  });

  it("interpolation funktioniert in en", () => {
    setLocale("en");
    expect(t("library.gamesCount", { n: 0 })).toBe("/ 0 games");
    expect(t("library.gamesCount", { n: 42 })).toBe("/ 42 games");
    expect(t("cleanup.selectedInfo", { n: 28, size: "14.2 GB" })).toBe("28 selected · 14.2 GB");
    expect(t("proton.usedBy", { n: 3 })).toBe("explicit game mappings: 3 →");
  });

  it("tier-kurznamen sind in en idiomatisch", () => {
    setLocale("en");
    // die ausführlichen ProtonDB-beschreibungen (`tier.*`) waren tote keys und
    // wurden entfernt (U-07); sichtbar ist der kurzname aus `tierName.*`.
    expect(t("tierName.platinum")).toBe("Platinum");
    expect(t("tierName.borked")).toBe("Borked");
  });

  it("footprint-texte bleiben in de und en vorhanden", () => {
    setLocale("de");
    expect(t("drawer.footprintTitle")).toBe("speicherbedarf");
    expect(t("drawer.footprintMeasure")).toBe("speicherbedarf messen");
    expect(t("drawer.footprintSummaryPartial")).toBe("teilweise");
    expect(t("drawer.footprintCompatdataNotChecked")).toContain("nicht geprüft");

    setLocale("en");
    expect(t("drawer.footprintTitle")).toBe("known footprint");
    expect(t("drawer.footprintMeasure")).toBe("measure storage footprint");
    expect(t("drawer.footprintSummaryPartial")).toBe("partial");
    expect(t("drawer.footprintCompatdataNotChecked")).toContain("not checked");
  });
});
