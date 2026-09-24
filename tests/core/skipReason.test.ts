import { describe, expect, it } from "vitest";
import { skipReasonKind } from "../../src/core/skipReason.js";
import type { SkipReason } from "../../src/core/types.js";

// ein Record über alle `SkipReason`-werte ist die vollständigkeitsklammer: ein
// neuer grund ohne eintrag fällt in `npm run check` als typfehler auf, nicht
// erst in der UI als leerer text.
const ERWARTET: Record<SkipReason, string> = {
  "path-missing": "not-found",
  "scope-failed": "blocked",
  "read-failed": "unreadable",
  unverified: "incomplete",
};

describe("skipReasonKind", () => {
  it("bildet jeden discovery-grund auf die kanonische fehlerklasse ab", () => {
    for (const [reason, kind] of Object.entries(ERWARTET) as [SkipReason, string][]) {
      expect(skipReasonKind(reason)).toBe(kind);
    }
  });

  it("liefert nie unknown: jeder grund ist belegt", () => {
    // die unterscheidung ist kein schmuck: `unknown` bedeutet in der UI
    // "ursache unklar", die vier gruende sind aber alle bekannt.
    for (const reason of Object.keys(ERWARTET) as SkipReason[]) {
      expect(skipReasonKind(reason)).not.toBe("unknown");
    }
  });
});
