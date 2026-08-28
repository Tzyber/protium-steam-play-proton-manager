import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DELETE_CLAIM_PREFIX,
  findIncompleteDeletions,
  findOrphans,
  findSteamOwnedPrefixes,
} from "../../src/core/cleanup.js";
import { scanGames } from "../../src/core/scan/games.js";
import { buildFakeSteam, fakeSystem, nodeFs } from "../support/fakeSteam";

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
    const orphans = await findOrphans(libraries, installedAppIds, new Set(), fs);

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
    const orphans = await findOrphans(libraries, installedAppIds, new Set(), fs);

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

    const orphans = await findOrphans([lib2], installedAppIds, new Set(), fs);

    expect(orphans).toEqual([]);
  });

  it("blocklistete appIDs (proton-builtin etc.) werden nicht als orphan angeboten", async () => {
    const { fs, libraries, installedAppIds } = await setup();
    // 999999 hat ein manifest (blocklist-fall wie proton-builtin 4628710):
    // prefix existiert, aber die app ist kein spiel → kein orphan.
    const orphans = await findOrphans(libraries, installedAppIds, new Set([999999]), fs);

    expect(orphans.map((o) => o.appId)).not.toContain(999999);
    expect(orphans.some((o) => o.appId === 888888)).toBe(true);
  });

  it("manifestloser blocklist-fall: scan → cleanup bietet den prefix als orphan an (bewusster vertrag)", async () => {
    // 4628710 (proton-builtin) hat KEIN manifest. der scan kennt die id nur
    // über manifeste als blockiert, also nicht hier; der prefix ist damit ein
    // echter rest und wird als orphan angeboten. der filter verlässt sich nie
    // auf die statische blocklist allein.
    const { root, fs } = await setup();
    await fs.mkdir(`${root}/steamapps/compatdata/4628710`);

    const scan = await scanGames(nodeFs(), fakeSystem(), root, [root], () => "default", null);
    expect(scan.blockedAppIds.has(4628710)).toBe(false);

    const installed = new Set(scan.games.map((game) => game.appId));
    const orphans = await findOrphans([root], installed, scan.blockedAppIds, fs);
    expect(orphans.map((o) => o.appId)).toContain(4628710);
    // die echtes-orphan-fixture bleibt unbeeinflusst
    expect(orphans.map((o) => o.appId)).toContain(999999);
  });

  it("blocklist-fall mit manifest: scan → cleanup bietet den prefix nicht als orphan an", async () => {
    const { root, fs } = await setup();
    await fs.mkdir(`${root}/steamapps/compatdata/4628710`);
    await writeFile(
      join(root, "steamapps/appmanifest_4628710.acf"),
      `"AppState"\n{\n\t"appid"\t\t"4628710"\n\t"name"\t\t"Proton 11.0"\n}\n`,
    );

    const scan = await scanGames(nodeFs(), fakeSystem(), root, [root], () => "default", null);
    expect(scan.blockedAppIds.has(4628710)).toBe(true);

    const installed = new Set(scan.games.map((game) => game.appId));
    const orphans = await findOrphans([root], installed, scan.blockedAppIds, fs);
    expect(orphans.map((o) => o.appId)).not.toContain(4628710);
  });

  it("basis-ordner fehlt → kein throw, leeres teilergebnis", async () => {
    const { fs, libraries, installedAppIds } = await setup();
    // lib2 hat keine compatdata/shadercache dirs, sollte nicht crashen
    const orphans = await findOrphans([libraries[1] as string], installedAppIds, new Set(), fs);
    expect(orphans).toEqual([]);
  });

  it("defekte/nicht lesbare library → skip, kein throw", async () => {
    const { fs, installedAppIds } = await setup();
    const orphans = await findOrphans(["/nicht/existenter/pfad"], installedAppIds, new Set(), fs);
    expect(orphans).toEqual([]);
  });

  it("gleiche appId in beiden typen → zwei getrennte entries", async () => {
    const { fs, libraries, installedAppIds } = await setup();
    const orphans = await findOrphans(libraries, installedAppIds, new Set(), fs);

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
    const orphans = await findOrphans(libraries, installedAppIds, new Set(), fs);

    const paths = orphans.map((o) => o.path);
    expect(paths.every((p) => !p.includes("symlink"))).toBe(true);
  });

  it("shortcut-appId in installedAppIds → prefix nicht als orphan", async () => {
    const { fs, libraries } = await setup();
    const installedWithShortcut = new Set([570, 620, 730, 3641016077]);
    const orphans = await findOrphans(libraries, installedWithShortcut, new Set(), fs);

    const shortcutPrefix = orphans.find((o) => o.appId === 3641016077);
    expect(shortcutPrefix).toBeUndefined();
  });

  it("shortcut-bereich-appId (2^31..2^32-1) wird nach shortcut-entfernung als orphan angeboten", async () => {
    const { fs, libraries } = await setup();
    // 3641016077 ist NICHT mehr als shortcut installiert: sein prefix ist ein
    // echter rest und muss angeboten werden (früher still unsichtbar wegen der
    // 2^31-1-grenze in parseSafeAppId; das rust-backend akzeptiert u32::MAX).
    const withoutShortcut = new Set([570, 620, 730]);
    const orphans = await findOrphans(libraries, withoutShortcut, new Set(), fs);

    const shortcutPrefix = orphans.find((o) => o.appId === 3641016077);
    expect(shortcutPrefix).toBeDefined();
    expect(shortcutPrefix?.type).toBe("compatdata");
  });
});

describe("findSteamOwnedPrefixes", () => {
  it("findet compatdata-Prefixes blocklisteter AppIDs mit Pfad und appId", async () => {
    const { root, fs, libraries } = await setup();
    const blocked = new Set([4628710]);
    await fs.mkdir(`${root}/steamapps/compatdata/4628710`);

    const found = await findSteamOwnedPrefixes(libraries, blocked, fs);

    expect(found).toEqual([
      {
        appId: 4628710,
        path: `${root}/steamapps/compatdata/4628710`,
        library: root,
      },
    ]);
  });

  it("durchsucht kein shadercache", async () => {
    const { root, fs, libraries } = await setup();
    const blocked = new Set([4628710]);
    await fs.mkdir(`${root}/steamapps/shadercache/4628710`);

    const found = await findSteamOwnedPrefixes(libraries, blocked, fs);

    expect(found).toEqual([]);
  });

  it("zählt claim-reste nicht mit", async () => {
    const { root, fs, libraries } = await setup();
    const blocked = new Set([4628710]);
    await fs.mkdir(`${root}/steamapps/compatdata/${DELETE_CLAIM_PREFIX}4628710`);

    const found = await findSteamOwnedPrefixes(libraries, blocked, fs);

    expect(found).toEqual([]);
  });

  it("liefert eine leere liste statt undefined, wenn nichts gefunden wird", async () => {
    const { fs, libraries } = await setup();

    const found = await findSteamOwnedPrefixes(libraries, new Set(), fs);

    expect(found).toEqual([]);
  });

  it("konsistenz: filter und meldung beschreiben dieselbe menge", async () => {
    const { root, fs, libraries, installedAppIds } = await setup();
    const blocked = new Set([4628710]);
    await fs.mkdir(`${root}/steamapps/compatdata/4628710`); // steam-eigen (gefiltert)
    await fs.mkdir(`${root}/steamapps/compatdata/999999`); // echtes orphan

    const orphans = await findOrphans(libraries, installedAppIds, blocked, fs);
    const owned = await findSteamOwnedPrefixes(libraries, blocked, fs);

    const orphanPaths = new Set(orphans.map((o) => o.path));
    const ownedPaths = new Set(owned.map((p) => p.path));
    for (const path of orphanPaths) {
      expect(ownedPaths.has(path)).toBe(false);
    }
    for (const path of ownedPaths) {
      expect(orphanPaths.has(path)).toBe(false);
    }
    // beide bekannten verzeichnisse müssen in genau einer liste stecken
    expect(orphanPaths.has(`${root}/steamapps/compatdata/999999`)).toBe(true);
    expect(ownedPaths.has(`${root}/steamapps/compatdata/4628710`)).toBe(true);
  });
});

describe("findIncompleteDeletions", () => {
  it("findet Claims je Typ und schließt Dateien, Symlinks und Orphans aus", async () => {
    const { root, lib2, fs, libraries, installedAppIds } = await setup();
    const compatClaim = `${root}/steamapps/compatdata/${DELETE_CLAIM_PREFIX}compat`;
    const shaderClaim = `${lib2}/steamapps/shadercache/${DELETE_CLAIM_PREFIX}shader`;
    const fileClaim = `${root}/steamapps/compatdata/${DELETE_CLAIM_PREFIX}file`;
    const symlinkClaim = `${root}/steamapps/compatdata/${DELETE_CLAIM_PREFIX}symlink`;

    await fs.mkdir(compatClaim);
    await fs.mkdir(shaderClaim);
    await fs.writeTextFile(fileClaim, "kein verzeichnis");
    await symlink(compatClaim, symlinkClaim, "dir");

    const incomplete = await findIncompleteDeletions(libraries, root, fs);
    expect(incomplete).toHaveLength(2);
    expect(incomplete.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([`${DELETE_CLAIM_PREFIX}compat`, `${DELETE_CLAIM_PREFIX}shader`]),
    );
    expect(incomplete.find((entry) => entry.path === compatClaim)?.type).toBe("compatdata");
    expect(incomplete.find((entry) => entry.path === shaderClaim)?.type).toBe("shadercache");

    const orphans = await findOrphans(libraries, installedAppIds, new Set(), fs);
    expect(orphans.every((entry) => !entry.path.includes(DELETE_CLAIM_PREFIX))).toBe(true);
  });

  it("findet Claim-Reste im papierkorb (abgebrochener trash-delete)", async () => {
    const { root, lib2, fs, libraries } = await setup();
    const trashClaim = `${root}/steamapps/.protium-trash/${DELETE_CLAIM_PREFIX}trash`;
    const trashClaim2 = `${lib2}/steamapps/.protium-trash/${DELETE_CLAIM_PREFIX}trash2`;
    await fs.mkdir(trashClaim);
    await fs.mkdir(trashClaim2);

    const incomplete = await findIncompleteDeletions(libraries, root, fs);

    const trashRest = incomplete.find((entry) => entry.path === trashClaim);
    expect(trashRest).toBeDefined();
    expect(trashRest?.type).toBe("trash");
    expect(trashRest?.library).toBe(root);
    expect(incomplete.some((entry) => entry.path === trashClaim2)).toBe(true);
  });

  it("findet Claim-Reste in compatibilitytools.d (abgebrochener tool-delete)", async () => {
    const { root, fs, libraries } = await setup();
    const toolClaim = `${root}/compatibilitytools.d/${DELETE_CLAIM_PREFIX}tool`;
    await fs.mkdir(toolClaim);

    const incomplete = await findIncompleteDeletions(libraries, root, fs);

    const toolRest = incomplete.find((entry) => entry.path === toolClaim);
    expect(toolRest).toBeDefined();
    expect(toolRest?.type).toBe("compat-tool");
    expect(toolRest?.library).toBe(root);
  });

  it("überspringt fehlende oder nicht lesbare basisordner", async () => {
    const { fs } = await setup();

    await expect(
      findIncompleteDeletions(["/nicht/existenter/pfad"], "/nicht/steam", fs),
    ).resolves.toEqual([]);
  });
});
