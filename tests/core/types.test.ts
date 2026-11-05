// Die Rohwert-Validatoren sind die Grenze zwischen untypisiertem Backend-JSON
// und der Domäne. Die Wertelisten sind die Wahrheit: alles, was kein exakt
// passender String ist, fällt auf den Leerwert. Ein Umbau von `oneOf` auf einen
// Objekt-Lookup oder einen Truthy-Test würde 42, true, Arrays und Objekte
// durchlassen; diese Fälle halten die Nicht-String-Ablehnung fest (Review P2-2).

import { describe, expect, it } from "vitest";
import {
  asCompatConfigStatus,
  asCompatToolSource,
  asLaunchConfigStatus,
  asSkipReason,
  asTier,
  SKIP_REASONS,
  type SkipReason,
} from "../../src/core/types.js";

/** Rohwerte, die ein Feld annehmen kann, das kein String ist. */
const NON_STRING_RAW: readonly { fall: string; raw: unknown }[] = [
  { fall: "zahl 42", raw: 42 },
  { fall: "null", raw: null },
  { fall: "boolean true", raw: true },
  { fall: 'array ["gold"]', raw: ["gold"] },
  { fall: 'objekt { tier: "gold" }', raw: { tier: "gold" } },
];

describe("asTier", () => {
  it.each(NON_STRING_RAW)("$fall ergibt unknown", ({ raw }) => {
    expect(asTier(raw)).toBe("unknown");
  });

  it("gibt einen gültigen string unverändert zurück", () => {
    expect(asTier("gold")).toBe("gold");
  });
});

describe("asCompatConfigStatus", () => {
  it.each(NON_STRING_RAW)("$fall ergibt unknown", ({ raw }) => {
    expect(asCompatConfigStatus(raw)).toBe("unknown");
  });

  it("gibt einen gültigen string unverändert zurück", () => {
    expect(asCompatConfigStatus("unreadable")).toBe("unreadable");
  });
});

describe("asLaunchConfigStatus", () => {
  it.each(NON_STRING_RAW)("$fall ergibt unknown", ({ raw }) => {
    expect(asLaunchConfigStatus(raw)).toBe("unknown");
  });

  it("gibt einen gültigen string unverändert zurück", () => {
    expect(asLaunchConfigStatus("ambiguous")).toBe("ambiguous");
  });
});

describe("asCompatToolSource", () => {
  it.each(NON_STRING_RAW)("$fall ergibt unavailable", ({ raw }) => {
    expect(asCompatToolSource(raw)).toBe("unavailable");
  });

  it("gibt einen gültigen string unverändert zurück", () => {
    expect(asCompatToolSource("explicit")).toBe("explicit");
  });
});

describe("asSkipReason", () => {
  it.each(NON_STRING_RAW)("$fall ergibt unverified", ({ raw }) => {
    expect(asSkipReason(raw)).toBe("unverified");
  });

  it("macht einen fremden string zu unverified", () => {
    expect(asSkipReason("bogus")).toBe("unverified");
  });

  it.each(SKIP_REASONS)("gibt den gültigen wert %s unverändert zurück", (reason) => {
    expect(asSkipReason(reason)).toBe(reason);
  });

  it("kennt jeden SkipReason-wert", () => {
    // die werteliste ist die wahrheit: ein neuer grund ohne eintrag fällt hier
    // auf, bevor die UI ihn als unbekannt ausgibt.
    const alle: Record<SkipReason, true> = {
      "path-missing": true,
      "scope-failed": true,
      "read-failed": true,
      unverified: true,
    };
    expect([...SKIP_REASONS].sort()).toEqual(Object.keys(alle).sort());
  });
});

describe("wertelisten bleiben getrennt", () => {
  it("lehnt einen gültigen string aus einer anderen liste ab", () => {
    // "ambiguous" ist nur launch-config-status; die vier listen dürfen nicht
    // zu einer gemeinsamen menge zusammenwachsen.
    expect(asCompatConfigStatus("ambiguous")).toBe("unknown");
    expect(asLaunchConfigStatus("unavailable")).toBe("unknown");
    expect(asTier("explicit")).toBe("unknown");
    expect(asCompatToolSource("gold")).toBe("unavailable");
  });
});
