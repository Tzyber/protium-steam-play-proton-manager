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
  asTier,
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
