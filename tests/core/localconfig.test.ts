import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findActiveUser, readLaunchOptions } from "../../src/core/localconfig.js";
import { buildFakeSteam, nodeFs } from "../support/fakeSteam.js";

describe("findActiveUser", () => {
  it("findet den einzigen account mit localconfig.vdf", async () => {
    const { root, userId } = await buildFakeSteam();
    const found = await findActiveUser(nodeFs(), root);
    expect(found).toEqual({ status: "selected", userId, selection: "unique" });
  });

  it("meldet fehlenden account ohne userdata-verzeichnis", async () => {
    const leer = await mkdtemp(join(tmpdir(), "protium-nouser-"));
    expect(await findActiveUser(nodeFs(), leer)).toEqual({ status: "missing" });
  });

  it("unterscheidet unlesbare userdata von fehlendem account", async () => {
    const { root } = await buildFakeSteam();
    const baseFs = nodeFs();
    const userdata = join(root, "userdata");
    const fs = {
      ...baseFs,
      readDir: async (path: string) => {
        if (path === userdata) throw new Error("read denied");
        return baseFs.readDir(path);
      },
    };

    expect(await findActiveUser(fs, root)).toEqual({
      status: "unreadable",
      detail: "read denied",
    });
  });

  it("bei mehreren accounts entscheidet loginusers.vdf (MostRecent)", async () => {
    const { root, userId } = await buildFakeSteam();
    // zweiter account MIT localconfig, loginusers zeigt weiter auf userId
    await mkdir(join(root, "userdata", "222222222", "config"), { recursive: true });
    await writeFile(
      join(root, "userdata", "222222222", "config", "localconfig.vdf"),
      `"UserLocalConfigStore"\n{\n}\n`,
      "utf8",
    );
    const found = await findActiveUser(nodeFs(), root);
    expect(found).toEqual({ status: "selected", userId, selection: "unique" });
  });

  it("fallback ohne loginusers.vdf: numerisch kleinster account, nicht lexikographisch", async () => {
    // lexikographisch läge "10" vor "2", das wäre der falsche account.
    const root = await mkdtemp(join(tmpdir(), "protium-multiuser-"));
    for (const id of ["10", "2"]) {
      await mkdir(join(root, "userdata", id, "config"), { recursive: true });
      await writeFile(
        join(root, "userdata", id, "config", "localconfig.vdf"),
        `"UserLocalConfigStore"\n{\n}\n`,
        "utf8",
      );
    }
    const found = await findActiveUser(nodeFs(), root);
    expect(found).toEqual({ status: "selected", userId: "2", selection: "ambiguous" });
  });
});

it("liest launch-options direkt aus localconfig.vdf", async () => {
  const { root, userId } = await buildFakeSteam();
  const text = await readFile(join(root, "userdata", userId, "config", "localconfig.vdf"), "utf8");
  expect(readLaunchOptions(text, 620)).toBe("gamemoderun %command%");
  expect(readLaunchOptions(text, 730)).toBeUndefined();
});
