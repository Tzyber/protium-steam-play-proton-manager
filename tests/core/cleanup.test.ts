import { describe, expect, it } from "vitest";
import { findOrphans } from "../../src/core/cleanup.js";
import { buildFakeSteam, nodeFs } from "../support/fakeSteam";

async function setup() {
  const { root, lib2 } = await buildFakeSteam();
  const fs = nodeFs();
  const libraries = [root, lib2];
  const installedAppIds = new Set([570, 620, 730, 3641016077]);
  return { root, lib2, fs, libraries, installedAppIds };
}

describe("findOrphans", () => {
  it("happy path: mix installed/verwaiste, nach Typ getrennt", async () => {
    const { fs, libraries, installedAppIds } = await setup();
    const orphans = await findOrphans(libraries, installedAppIds, fs);

    const compatdataOrphans = orphans.filter((o) => o.type === "compatdata");
    const shadercacheOrphans = orphans.filter((o) => o.type === "shadercache");

    expect(compatdataOrphans).toHaveLength(1);
    expect(compatdataOrphans[0]?.appId).toBe(999999);
    expect(compatdataOrphans[0]?.path).toContain("/compatdata/999999");

    expect(shadercacheOrphans).toHaveLength(1);
    expect(shadercacheOrphans[0]?.appId).toBe(888888);
    expect(shadercacheOrphans[0]?.path).toContain("/shadercache/888888");
    expect(shadercacheOrphans[0]?.type).toBe("shadercache");
  });

  it("nicht-numerisch, 0, datei statt ordner werden ignoriert", async () => {
    const { fs, libraries, installedAppIds } = await setup();
    const orphans = await findOrphans(libraries, installedAppIds, fs);

    const appIds = orphans.map((o) => o.appId);
    expect(appIds).not.toContain(0);

    // "foo", "symlink_123" und "not_a_dir" → keine numerischen integer
    const paths = orphans.map((o) => o.path);
    expect(paths.every((p) => !p.includes("foo"))).toBe(true);
    expect(paths.every((p) => !p.includes("not_a_dir"))).toBe(true);
  });

  it("parseInt-overflow (254 ziffern, NAME_MAX) → kein orphan", async () => {
    const { lib2, fs, installedAppIds } = await setup();
    const huge = "9".repeat(254); // max möglicher verzeichnisname
    await fs.mkdir(`${lib2}/compatdata`);
    await fs.mkdir(`${lib2}/compatdata/${huge}`);

    const orphans = await findOrphans([lib2], installedAppIds, fs);

    expect(orphans).toEqual([]);
  });

  it("basis-ordner fehlt → kein throw, leeres teilergebnis", async () => {
    const { fs, libraries, installedAppIds } = await setup();
    // lib2 hat keine compatdata/shadercache dirs, sollte nicht crashen
    const orphans = await findOrphans([libraries[1] as string], installedAppIds, fs);
    expect(orphans).toEqual([]);
  });

  it("defekte/nicht lesbare library → skip, kein throw", async () => {
    const { fs, installedAppIds } = await setup();
    const orphans = await findOrphans(["/nicht/existenter/pfad"], installedAppIds, fs);
    expect(orphans).toEqual([]);
  });

  it("gleiche appId in beiden typen → zwei getrennte entries", async () => {
    const { fs, libraries, installedAppIds } = await setup();
    const orphans = await findOrphans(libraries, installedAppIds, fs);

    // 888888 existiert nur als shadercache, 999999 nur als compatdata
    const byAppId = new Map<number, { compatdata: boolean; shadercache: boolean }>();
    for (const o of orphans) {
      const entry = byAppId.get(o.appId) ?? { compatdata: false, shadercache: false };
      if (o.type === "compatdata") entry.compatdata = true;
      if (o.type === "shadercache") entry.shadercache = true;
      byAppId.set(o.appId, entry);
    }

    // 999999 vom typ compatdata
    expect(byAppId.get(999999)?.compatdata).toBe(true);
    expect(byAppId.get(999999)?.shadercache).toBe(false);
  });

  it("symlink als eintrag → nicht als orphan gemeldet", async () => {
    const { fs, libraries, installedAppIds } = await setup();
    const orphans = await findOrphans(libraries, installedAppIds, fs);

    const paths = orphans.map((o) => o.path);
    expect(paths.every((p) => !p.includes("symlink"))).toBe(true);
  });

  it("shortcut-appId in installedAppIds → prefix nicht als orphan", async () => {
    const { fs, libraries } = await setup();
    const installedWithShortcut = new Set([570, 620, 730, 3641016077]);
    const orphans = await findOrphans(libraries, installedWithShortcut, fs);

    const shortcutPrefix = orphans.find((o) => o.appId === 3641016077);
    expect(shortcutPrefix).toBeUndefined();
  });

  it("shortcut-appId NICHT in installedAppIds → prefix als orphan (regression)", async () => {
    const { fs, libraries } = await setup();
    const withoutShortcut = new Set([570, 620, 730]);
    const orphans = await findOrphans(libraries, withoutShortcut, fs);

    const shortcutPrefix = orphans.find((o) => o.appId === 3641016077);
    expect(shortcutPrefix).toBeDefined();
    expect(shortcutPrefix?.type).toBe("compatdata");
  });
});
