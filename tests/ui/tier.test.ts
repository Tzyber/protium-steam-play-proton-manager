// T-04: `src/ui/tier.ts` fließt in TierBadge, FilterBar und Drawer, hatte aber
// keinen direkten Test. Diese Datei verankert Farbe, englischen Markennamen und
// lokalisierten Kurznamen unabhängig von einer bestimmten Komponente.

import { afterEach, describe, expect, it } from "vitest";
import type { Tier } from "../../src/core/types";
import { setLocale, t } from "../../src/ui/i18n";
import { tierName, tierText, tierTone } from "../../src/ui/tier";

const TIERS: Tier[] = ["platinum", "gold", "silver", "bronze", "borked", "unknown"];

afterEach(() => setLocale("en"));

describe("tierTone", () => {
  it("liefert je stufe genau eine eigene CSS-variable", () => {
    for (const tier of TIERS) {
      expect(tierTone(tier)).toBe(`var(--tier-${tier})`);
    }
    expect(new Set(TIERS.map((tier) => tierTone(tier))).size).toBe(TIERS.length);
  });
});

describe("tierText", () => {
  it("liefert den englischen Markennamen, unabhängig von der Sprache", () => {
    for (const locale of ["de", "en"] as const) {
      setLocale(locale);
      expect(tierText("platinum")).toBe("Platinum");
      expect(tierText("borked")).toBe("Borked");
    }
  });

  it("übersetzt nur 'unknown' über die i18n", () => {
    setLocale("de");
    expect(tierText("unknown")).toBe(t("support.unknown"));
    expect(tierText("unknown")).not.toBe("unknown");
  });
});

describe("tierName", () => {
  it("löst für jede stufe und sprache einen echten key auf", () => {
    for (const locale of ["de", "en"] as const) {
      setLocale(locale);
      for (const tier of TIERS) {
        const key = `tierName.${tier}` as Parameters<typeof t>[0];
        expect(tierName(tier)).toBe(t(key));
        expect(tierName(tier)).not.toBe(key);
      }
    }
  });

  it("zeigt deutsche und englische kurzformen", () => {
    setLocale("de");
    expect(tierName("platinum")).toBe("Platin");
    setLocale("en");
    expect(tierName("platinum")).toBe("Platinum");
    expect(tierName("borked")).toBe("Borked");
  });
});
