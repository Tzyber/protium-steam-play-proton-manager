import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanGames } from "../../../src/core/scan/games.js";
import { buildFakeSteam, fakeSystem, nodeFs } from "../../support/fakeSteam";

describe("scanGames", () => {
  it("klassifiziert eine nicht lesbare library als read-failed", async () => {
    const { root } = await buildFakeSteam();
    const baseFs = nodeFs();
    const appsDir = join(root, "steamapps");
    const fs = {
      ...baseFs,
      readDir: async (path: string) => {
        if (path === appsDir) throw new Error("read denied");
        return baseFs.readDir(path);
      },
    };

    const result = await scanGames(fs, fakeSystem(), root, [root], () => "default", null);

    expect(result.games).toEqual([]);
    expect(result.blockedAppIds).toEqual(new Set());
    expect(result.warnings).toEqual([`library "${root}" nicht lesbar: read denied`]);
    expect(result.skippedLibraries).toEqual([{ path: root, reason: "read-failed" }]);
  });

  it("liest appmanifest_042.acf über entry.name statt über die numerische id", async () => {
    const { root } = await buildFakeSteam();
    await writeFile(
      join(root, "steamapps/appmanifest_042.acf"),
      `"AppState"
{
	"appid"		"42"
	"name"		"Zero Prefix"
	"SizeOnDisk"		"1234"
}
`,
    );

    const result = await scanGames(nodeFs(), fakeSystem(), root, [root], () => "default", null);
    const game = result.games.find((candidate) => candidate.appId === 42);

    expect(game).toEqual(
      expect.objectContaining({
        appId: 42,
        name: "Zero Prefix",
        sizeBytes: 1234,
        compatTool: "default",
      }),
    );
    expect(
      result.warnings.some((warning) => warning.startsWith("appmanifest_042.acf übersprungen:")),
    ).toBe(false);
  });
});
