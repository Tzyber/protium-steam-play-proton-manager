import { describe, expect, it } from "vitest";
import { readCompatTools } from "../../../src/core/scan/tools.js";
import type { Game } from "../../../src/core/types.js";
import { buildFakeSteam, fakeSystem, nodeFs } from "../../support/fakeSteam";

describe("readCompatTools", () => {
  it("liefert default, installierte built-in-protons und usedBy nur für installierte spiele", async () => {
    const { root, systemCompat } = await buildFakeSteam();
    const games: Game[] = [
      {
        appId: 620,
        name: "Portal 2",
        library: root,
        sizeBytes: 0,
        compatTool: "GE-Proton9-27",
        compatToolSource: "explicit",
        protonDb: null,
        localHeader: null,
        headerImage: null,
      },
      {
        appId: 730,
        name: "Counter-Strike 2",
        library: root,
        sizeBytes: 0,
        compatTool: "proton-cachyos-slr",
        compatToolSource: "explicit",
        protonDb: null,
        localHeader: null,
        headerImage: null,
      },
    ];

    const result = await readCompatTools(
      nodeFs(),
      fakeSystem(),
      root,
      new Map([
        [0, "proton-cachyos-slr"],
        [620, "GE-Proton9-27"],
        [730, "proton-cachyos-slr"],
        [999999, "proton-cachyos-slr"],
      ]),
      new Set([1493710]),
      games,
      [systemCompat],
    );

    expect(result.defaultCompatTool).toBe("proton-cachyos-slr");
    expect(result.compatToolCounts).toEqual({ read: 3, failed: 0 });
    expect(result.builtinProtonsInstalled).toEqual([
      { internalName: "proton_experimental", displayName: "Proton Experimental" },
    ]);

    expect(result.compatToolsInstalled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "GE-Proton9-27", usedBy: [620] }),
        expect.objectContaining({ internalName: "proton-cachyos-slr", usedBy: [730] }),
      ]),
    );
  });

  it("behält ein tool mit fehlgeschlagener größenmessung im inventar", async () => {
    const { root, systemCompat } = await buildFakeSteam();
    const system = {
      ...fakeSystem(),
      dirSize: async () => {
        throw new Error("disk error");
      },
    };

    const result = await readCompatTools(
      nodeFs(),
      system,
      root,
      new Map(),
      new Set(),
      [],
      [systemCompat],
    );

    // fixture hat 3 tools; alle bleiben im inventar, alle mit unbekannter größe.
    expect(result.compatToolCounts).toEqual({ read: 3, failed: 3 });
    expect(result.compatToolsInstalled).toHaveLength(3);
    expect(result.compatToolsInstalled.every((tool) => tool.sizeBytes === undefined)).toBe(true);
    expect(result.warnings.some((warning) => warning.reason === "size-unreadable")).toBe(true);
  });
});
