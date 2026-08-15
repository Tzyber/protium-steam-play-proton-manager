import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCompatMapping, readLaunchConfig } from "../../../src/core/scan/config.js";
import { buildFakeSteam, nodeFs } from "../../support/fakeSteam";

describe("scan config", () => {
  it("markiert fehlende compat-konfiguration als unbenutzbar", async () => {
    const { root } = await buildFakeSteam();
    await rm(join(root, "config", "config.vdf"));

    const result = await readCompatMapping(nodeFs(), root);

    expect(result.mapping).toEqual(new Map());
    expect(result.mappingUsable).toBe(false);
    expect(result.warnings).toEqual(["config.vdf fehlt → compat-tools als 'unknown' markiert"]);
  });

  it("behält den aktiven account bei, wenn seine localconfig nicht lesbar ist", async () => {
    const { root, userId } = await buildFakeSteam();
    const baseFs = nodeFs();
    const localConfigPath = join(root, "userdata", userId, "config", "localconfig.vdf");
    const fs = {
      ...baseFs,
      readTextFile: async (path: string) => {
        if (path === localConfigPath) throw new Error("read denied");
        return baseFs.readTextFile(path);
      },
    };

    const result = await readLaunchConfig(fs, root);

    expect(result.steamUserId).toBe(userId);
    expect(result.localConfigText).toBeNull();
    expect(result.warnings).toEqual(["localconfig.vdf nicht lesbar: read denied"]);
  });
});
