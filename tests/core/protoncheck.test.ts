import { describe, expect, it } from "vitest";
import { deriveProtonCheck } from "../../src/core/protoncheck.js";
import type { CompatTool, Game, ScanResult } from "../../src/core/types.js";

const game = (
  appId: number,
  protonDb: Game["protonDb"],
  compatTool: string,
  compatToolSource: Game["compatToolSource"] = "unavailable",
): Game => ({
  appId,
  name: `game-${appId}`,
  library: "/steam",
  sizeBytes: 0,
  compatTool,
  compatToolSource,
  protonDb,
  localHeader: null,
  headerImage: null,
});

const customTool = (name: string, internalName = name): CompatTool => ({
  name,
  internalName,
  displayName: name,
  sizeBytes: 0,
  usedBy: [],
  source: "user",
});

const result = (
  games: Game[],
  compatToolsInstalled: CompatTool[] = [],
  builtinProtonsInstalled: ScanResult["builtinProtonsInstalled"] = [],
): Pick<ScanResult, "games" | "compatToolsInstalled" | "builtinProtonsInstalled"> => ({
  games,
  compatToolsInstalled,
  builtinProtonsInstalled,
});

describe("deriveProtonCheck", () => {
  it("liefert nur bronze, borked und explizit unbekannte tools", () => {
    const checks = deriveProtonCheck(
      result([
        game(1, { tier: "bronze", confidence: "strong" }, "default"),
        game(2, { tier: "borked", confidence: "strong" }, "unknown"),
        game(3, { tier: "unknown", confidence: "unknown" }, "missing-tool", "explicit"),
        game(4, { tier: "gold", confidence: "strong" }, "default", "default"),
        game(5, { tier: "unknown", confidence: "unknown" }, "unknown"),
      ]),
    );

    expect(checks).toEqual([
      { appId: 1, reasons: ["tier-bronze"] },
      { appId: 2, reasons: ["tier-borked"] },
      { appId: 3, reasons: ["tool-not-recognized"] },
    ]);
  });

  it("erkennt custom-tools über internalName und verzeichnisname", () => {
    const checks = deriveProtonCheck(
      result(
        [
          game(1, null, "internal-tool", "explicit"),
          game(2, null, "directory-tool", "explicit"),
          game(3, null, "other-tool", "explicit"),
        ],
        [customTool("directory-tool", "internal-tool")],
      ),
    );

    expect(checks).toEqual([{ appId: 3, reasons: ["tool-not-recognized"] }]);
  });

  it("erkennt built-in protons nur über internalName", () => {
    const checks = deriveProtonCheck(
      result(
        [
          game(1, null, "proton_experimental", "explicit"),
          game(2, null, "Proton Experimental", "explicit"),
        ],
        [],
        [{ internalName: "proton_experimental", displayName: "Proton Experimental" }],
      ),
    );

    expect(checks).toEqual([{ appId: 2, reasons: ["tool-not-recognized"] }]);
  });

  it("fügt mehrere gründe deterministisch zusammen", () => {
    const checks = deriveProtonCheck(
      result([game(1, { tier: "borked", confidence: "strong" }, "gone", "explicit")]),
    );

    expect(checks).toEqual([{ appId: 1, reasons: ["tier-borked", "tool-not-recognized"] }]);
  });
});
