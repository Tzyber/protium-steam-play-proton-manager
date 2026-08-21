import { describe, expect, it } from "vitest";
import { readLibraryList } from "../../../src/core/scan/libraries.js";
import { buildFakeSteam } from "../../support/fakeSteam";

describe("readLibraryList", () => {
  it("verwendet ausschließlich die backendgelieferte Library-Liste", async () => {
    const { environment, root, lib2 } = await buildFakeSteam();
    const result = readLibraryList({ ...environment, libraries: [root, lib2] });

    expect(result.libraries).toEqual([root, lib2]);
    expect(result.warnings).toEqual([]);
    expect(result.skippedLibraries).toEqual([]);
  });

  it("reicht leere Listen fail-closed weiter", () => {
    const result = readLibraryList({
      generation: 1,
      steamRoot: "/tmp/steam",
      libraries: [],
      systemCompatDirs: [],
      appCacheDir: "/tmp/cache",
      appConfigDir: "/tmp/config",
    });

    expect(result.libraries).toEqual([]);
  });
});
