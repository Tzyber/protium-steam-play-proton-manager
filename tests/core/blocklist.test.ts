import { describe, expect, it } from "vitest";
import { availableBuiltinProtons, BLOCKLIST, blockReason } from "../../src/core/blocklist.js";

describe("blocklist", () => {
  it("blockt bekannte proton-appid", () =>
    expect(blockReason(1493710, "Proton Experimental")).toBe("id"));
  it("blockt Legacy Steam Runtime über die exakte appid", () =>
    expect(blockReason(4690330, "Legacy Steam Runtime")).toBe("id"));
  it("blockt via namens-heuristik", () =>
    expect(blockReason(4242, "Steam Linux Runtime 3.0")).toBe("name-heuristic"));
  it("lässt echtes spiel durch", () => expect(blockReason(620, "Portal 2")).toBe(null));
});

// one source of truth: BLOCKLIST ist die kanonische tabelle. der dropdown-flow
// (GameDetailDrawer.compatOptions) liest via availableBuiltinProtons aus
// derselben liste. ein zukünftiger split, z. b. eine separate appId→toolName-map
// für das dropdown, würde diese invariant brechen und der test schlägt fehl.
describe("kanonische tabelle (blocklist ↔ dropdown-flow)", () => {
  it("jeder proton-builtin-eintrag erscheint mit identischem toolnamen im dropdown", () => {
    for (const entry of BLOCKLIST) {
      if (entry.category !== "proton-builtin") continue;
      const installed = new Set([entry.appId]);
      const dropdown = availableBuiltinProtons(installed);
      const match = dropdown.find((d) => d.internalName === entry.toolName);
      expect(
        match,
        `appId ${entry.appId} (${entry.label}) muss mit toolName "${entry.toolName}" im dropdown auftauchen`,
      ).toBeDefined();
      expect(match?.displayName).toBe(entry.label);
    }
  });

  it("kein dropdown-eintrag ohne korrespondierenden blocklist-eintrag", () => {
    // umgekehrte richtung: der dropdown darf nichts erfinden, was nicht in
    // BLOCKLIST steht (würde eine zweite tabelle für die dropdown-daten bedeuten).
    const builtinToolNames = new Set(
      BLOCKLIST.filter((e) => e.category === "proton-builtin").map((e) => e.toolName),
    );
    const allInstalled = new Set(
      BLOCKLIST.filter((e) => e.category === "proton-builtin").map((e) => e.appId),
    );
    const dropdown = availableBuiltinProtons(allInstalled);
    for (const d of dropdown) {
      expect(
        builtinToolNames.has(d.internalName),
        `dropdown liefert toolName "${d.internalName}", der nicht in BLOCKLIST steht`,
      ).toBe(true);
    }
  });
});
