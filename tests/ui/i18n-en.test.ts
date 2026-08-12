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
    expect(t("errors.steamRunning")).toMatch(/steam is running/);
  });

  it("interpolation funktioniert in en", () => {
    setLocale("en");
    expect(t("library.gamesCount", { n: 0 })).toBe("/ 0 games");
    expect(t("library.gamesCount", { n: 42 })).toBe("/ 42 games");
    expect(t("cleanup.selectedInfo", { n: 28, size: "14.2 GB" })).toBe("28 selected · 14.2 GB");
    expect(t("proton.usedBy", { n: 3 })).toBe("3 game(s) →");
  });

  it("tier-labels sind in en idiomatisch", () => {
    setLocale("en");
    expect(t("tier.platinum")).toBe("runs perfectly, out of the box");
    expect(t("tier.borked")).toBe("does not run currently");
  });
});
