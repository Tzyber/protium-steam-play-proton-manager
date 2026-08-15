import { describe, expect, it } from "vitest";
import { readLibraryList } from "../../../src/core/scan/libraries.js";
import { buildFakeSteam, fakeSystem, nodeFs } from "../../support/fakeSteam";

describe("readLibraryList", () => {
  it("überspringt existierende libraries ohne identity vor jedem scope-zugriff", async () => {
    const { root, lib2 } = await buildFakeSteam();
    const fs = nodeFs();
    const system = fakeSystem();
    const identityOf = system.pathIdentity;
    system.pathIdentity = async (path) => (path === root ? null : identityOf(path));

    const result = await readLibraryList(fs, system, root);

    expect(result.libraries).toEqual([lib2]);
    expect(result.skippedLibraries).toEqual(
      expect.arrayContaining([{ path: root, reason: "scope-failed" }]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        `library-pfad nicht erreichbar (identity-check fehlgeschlagen), übersprungen: ${root}`,
      ]),
    );
    expect(system.scopedPaths).toEqual([]);
  });
});
