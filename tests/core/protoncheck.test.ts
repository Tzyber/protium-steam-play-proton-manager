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
  warnings: ScanResult["warnings"] = [],
): Pick<ScanResult, "games" | "compatToolsInstalled" | "builtinProtonsInstalled" | "warnings"> => ({
  games,
  compatToolsInstalled,
  builtinProtonsInstalled,
  warnings,
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

  it("unterdrückt tool-not-recognized bei unlesbarem tool-verzeichnis", () => {
    const checks = deriveProtonCheck(
      result(
        [game(3, { tier: "unknown", confidence: "unknown" }, "missing-tool", "explicit")],
        [],
        [],
        [
          {
            type: "compat-tool",
            directory: "/steam/compatibilitytools.d",
            reason: "directory-unreadable",
          },
        ],
      ),
    );

    expect(checks).toEqual([]);
  });

  it("unterdrückt tool-not-recognized bei vdf-fehler eines eintrags", () => {
    const checks = deriveProtonCheck(
      result(
        [game(3, { tier: "unknown", confidence: "unknown" }, "missing-tool", "explicit")],
        [],
        [],
        [
          {
            type: "compat-tool",
            directory: "/steam/compatibilitytools.d",
            toolName: "other-tool",
            reason: "vdf-invalid",
          },
        ],
      ),
    );

    expect(checks).toEqual([]);
  });

  it("unterdrückt tool-not-recognized bei unlesbarer tool-vdf", () => {
    const checks = deriveProtonCheck(
      result(
        [game(3, { tier: "unknown", confidence: "unknown" }, "missing-tool", "explicit")],
        [],
        [],
        [
          {
            type: "compat-tool",
            directory: "/steam/compatibilitytools.d",
            toolName: "other-tool",
            reason: "vdf-unreadable",
          },
        ],
      ),
    );

    expect(checks).toEqual([]);
  });

  it("unterdrückt tool-not-recognized bei nicht lesbarer pfadidentität", () => {
    const checks = deriveProtonCheck(
      result(
        [game(3, { tier: "unknown", confidence: "unknown" }, "missing-tool", "explicit")],
        [],
        [],
        [
          {
            type: "compat-tool",
            directory: "/steam/compatibilitytools.d",
            reason: "path-identity",
          },
        ],
      ),
    );

    expect(checks).toEqual([]);
  });

  it("unterdrückt tool-not-recognized, wenn das gemappte tool als symlink vorliegt", () => {
    const checks = deriveProtonCheck(
      result(
        [game(3, { tier: "unknown", confidence: "unknown" }, "missing-tool", "explicit")],
        [],
        [],
        [
          {
            type: "compat-tool",
            directory: "/steam/compatibilitytools.d",
            toolName: "missing-tool",
            reason: "symlink",
          },
        ],
      ),
    );

    expect(checks).toEqual([]);
  });

  it("erlaubt tool-not-recognized trotz size-unreadable-warning eines anderen tools", () => {
    const checks = deriveProtonCheck(
      result(
        [game(3, { tier: "unknown", confidence: "unknown" }, "missing-tool", "explicit")],
        [],
        [],
        [
          {
            type: "compat-tool",
            directory: "/steam/compatibilitytools.d",
            toolName: "other-tool",
            reason: "size-unreadable",
          },
        ],
      ),
    );

    expect(checks).toEqual([{ appId: 3, reasons: ["tool-not-recognized"] }]);
  });

  it("erlaubt tool-not-recognized trotz symlink-warning eines anderen tools", () => {
    const checks = deriveProtonCheck(
      result(
        [game(3, { tier: "unknown", confidence: "unknown" }, "missing-tool", "explicit")],
        [],
        [],
        [
          {
            type: "compat-tool",
            directory: "/steam/compatibilitytools.d",
            toolName: "unrelated-link",
            reason: "symlink",
          },
        ],
      ),
    );

    expect(checks).toEqual([{ appId: 3, reasons: ["tool-not-recognized"] }]);
  });

  it("erkennt ein tool trotz unbekannter größe weiterhin", () => {
    const checks = deriveProtonCheck(
      result(
        [game(1, null, "internal-tool", "explicit")],
        [{ ...customTool("directory-tool", "internal-tool"), sizeBytes: undefined }],
      ),
    );

    expect(checks).toEqual([]);
  });

  it("lässt bronze/borked auch bei unvollständigem tool-scan bestehen", () => {
    const checks = deriveProtonCheck(
      result(
        [game(1, { tier: "bronze", confidence: "strong" }, "missing-tool", "explicit")],
        [],
        [],
        [
          {
            type: "compat-tool",
            directory: "/steam/compatibilitytools.d",
            reason: "directory-unreadable",
          },
        ],
      ),
    );

    expect(checks).toEqual([{ appId: 1, reasons: ["tier-bronze"] }]);
  });
});
