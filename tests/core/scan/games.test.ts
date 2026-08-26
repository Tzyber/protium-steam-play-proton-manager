import { rm, writeFile } from "node:fs/promises";
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
    expect(result.warnings).toEqual([
      {
        type: "library",
        path: root,
        reason: "read-failed",
        detail: `library "${root}" nicht lesbar: read denied`,
      },
    ]);
    expect(result.manifestCounts).toEqual({ read: 0, failed: 0 });
    expect(result.skippedLibraries).toEqual([{ path: root, reason: "read-failed" }]);
    expect(result.cleanupUnsafeLibraries).toEqual([]);
  });

  it("klassifiziert fehlendes steamapps als path-missing ohne cleanup-sperre", async () => {
    const { root, lib2: readableLibrary } = await buildFakeSteam();
    const baseFs = nodeFs();
    const appsDir = join(root, "steamapps");
    const readDirs: string[] = [];
    const fs = {
      ...baseFs,
      exists: async (path: string) => (path === appsDir ? false : baseFs.exists(path)),
      readDir: async (path: string) => {
        readDirs.push(path);
        return baseFs.readDir(path);
      },
    };

    const result = await scanGames(
      fs,
      fakeSystem(),
      root,
      [root, readableLibrary],
      () => "default",
      null,
    );

    expect(result.games.map((game) => game.library)).toEqual([readableLibrary, readableLibrary]);
    expect(result.warnings).toEqual([
      {
        type: "library",
        path: root,
        reason: "path-missing",
        detail: `library "${root}" fehlt: steamapps`,
      },
    ]);
    expect(result.skippedLibraries).toEqual([{ path: root, reason: "path-missing" }]);
    expect(result.cleanupUnsafeLibraries).toEqual([]);
    expect(readDirs).not.toContain(appsDir);
  });

  it("trennt Manifest-Lesefehler von unlesbarem Inhalt", async () => {
    const { root } = await buildFakeSteam();
    const baseFs = nodeFs();
    const unreadable = join(root, "steamapps/appmanifest_570.acf");
    const fs = {
      ...baseFs,
      readTextFile: async (path: string) => {
        if (path === unreadable) throw new Error("read denied");
        return baseFs.readTextFile(path);
      },
    };

    const result = await scanGames(fs, fakeSystem(), root, [root], () => "default", null);

    expect(result.manifestCounts).toEqual({ read: 1, failed: 2 });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "manifest",
          library: root,
          manifestName: "appmanifest_570.acf",
          appId: 570,
          reason: "unreadable",
          detail: "read denied",
        }),
        expect.objectContaining({
          type: "manifest",
          library: root,
          manifestName: "appmanifest_9999.acf",
          appId: 9999,
          reason: "invalid-content",
          detail: expect.any(String),
        }),
      ]),
    );
    expect(result.cleanupUnsafeLibraries).toContain(root);
    expect(result.games.some((game) => game.appId === 570)).toBe(false);
    expect(result.games.some((game) => game.appId === 9999)).toBe(false);
  });

  it("liest appmanifest_042.acf über entry.name statt über die numerische id", async () => {
    const { root } = await buildFakeSteam();
    await rm(join(root, "steamapps/appmanifest_9999.acf"), { force: true });
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
      result.warnings.some(
        (warning) => warning.type === "manifest" && warning.manifestName === "appmanifest_042.acf",
      ),
    ).toBe(false);
    expect(result.manifestCounts).toEqual({ read: 3, failed: 0 });
    expect(result.cleanupUnsafeLibraries).toEqual([]);
  });

  it("überspringt Manifest mit AppID-Mismatch und sperrt Library für Cleanup", async () => {
    const { root } = await buildFakeSteam();
    await writeFile(
      join(root, "steamapps/appmanifest_570.acf"),
      `"AppState"\n{\n\t"appid"\t\t"440"\n\t"name"\t\t"Mismatch Game"\n}\n`,
    );

    const result = await scanGames(nodeFs(), fakeSystem(), root, [root], () => "default", null);

    expect(result.games.find((g) => g.appId === 570 || g.appId === 440)).toBeUndefined();
    expect(
      result.warnings.some((w) => w.type === "manifest" && w.reason === "appid-mismatch"),
    ).toBe(true);
    expect(result.manifestCounts).toEqual({ read: 1, failed: 2 });
    expect(result.cleanupUnsafeLibraries).toContain(root);
  });

  it("überspringt Manifest mit ungültiger VDF-AppID (0, negativ, NaN, Overflow) und sperrt Library", async () => {
    const { root } = await buildFakeSteam();
    const fs = nodeFs();
    const appsDir = join(root, "steamapps");

    const cases = [
      { file: "appmanifest_100.acf", appid: "0", name: "Zero" },
      { file: "appmanifest_101.acf", appid: "-1", name: "Negative" },
      { file: "appmanifest_102.acf", appid: "abc", name: "NaN" },
      { file: "appmanifest_103.acf", appid: "", name: "Empty" },
      { file: "appmanifest_104.acf", appid: "9007199254740992", name: "Overflow" },
      { file: "appmanifest_105.acf", appid: "2147483648", name: "Too Large" },
    ];

    for (const c of cases) {
      await writeFile(
        join(appsDir, c.file),
        `"AppState"\n{\n\t"appid"\t\t"${c.appid}"\n\t"name"\t\t"${c.name}"\n\t"SizeOnDisk"\t\t"100"\n}\n`,
      );
    }

    const result = await scanGames(fs, fakeSystem(), root, [root], () => "default", null);

    expect(result.cleanupUnsafeLibraries).toContain(root);
    expect(result.games.some((g) => [100, 101, 102, 103, 104].includes(g.appId))).toBe(false);
    expect(result.games.some((g) => g.appId >= 2147483648)).toBe(false);
    expect(result.manifestCounts).toEqual({ read: 2, failed: 7 });
  });

  it("akzeptiert AppID 2147483647 aus Dateiname und Manifest", async () => {
    const { root } = await buildFakeSteam();
    await rm(join(root, "steamapps/appmanifest_9999.acf"), { force: true });
    await writeFile(
      join(root, "steamapps/appmanifest_2147483647.acf"),
      `"AppState"\n{\n\t"appid"\t\t"2147483647"\n\t"name"\t\t"Upper Bound"\n}\n`,
    );

    const result = await scanGames(nodeFs(), fakeSystem(), root, [root], () => "default", null);

    expect(result.games.map((game) => game.appId)).toContain(2147483647);
  });

  it("erkennt doppelte AppIDs über zwei Libraries, behält das erste Game und sperrt beide Libraries", async () => {
    const steam1 = await buildFakeSteam();
    const steam2 = await buildFakeSteam();
    const lib1 = steam1.root;
    const lib2 = steam2.root;

    const manifestContent = `"AppState"\n{\n\t"appid"\t\t"570"\n\t"name"\t\t"Dota 2"\n\t"SizeOnDisk"\t\t"5000"\n}\n`;
    await writeFile(join(lib1, "steamapps/appmanifest_570.acf"), manifestContent);
    await writeFile(join(lib2, "steamapps/appmanifest_570.acf"), manifestContent);

    const result = await scanGames(
      nodeFs(),
      fakeSystem(),
      lib1,
      [lib1, lib2],
      () => "default",
      null,
    );

    const dotaGames = result.games.filter((g) => g.appId === 570);
    expect(dotaGames).toHaveLength(1);
    expect(dotaGames[0]?.library).toBe(lib1);
    expect(result.warnings.some((w) => w.type === "manifest" && w.reason === "duplicate")).toBe(
      true,
    );
    expect(result.manifestCounts).toEqual({ read: 2, failed: 4 });
    expect(result.cleanupUnsafeLibraries).toContain(lib1);
    expect(result.cleanupUnsafeLibraries).toContain(lib2);
  });

  it("erkennt doppelte AppID innerhalb derselben Library und sperrt die Library", async () => {
    const { root } = await buildFakeSteam();
    await writeFile(
      join(root, "steamapps/appmanifest_570.acf"),
      `"AppState"\n{\n\t"appid"\t\t"570"\n\t"name"\t\t"Dota 2"\n}\n`,
    );
    await writeFile(
      join(root, "steamapps/appmanifest_0570.acf"),
      `"AppState"\n{\n\t"appid"\t\t"570"\n\t"name"\t\t"Dota 2 Dupe"\n}\n`,
    );

    const result = await scanGames(nodeFs(), fakeSystem(), root, [root], () => "default", null);

    const dotaGames = result.games.filter((g) => g.appId === 570);
    expect(dotaGames).toHaveLength(1);
    expect(result.warnings.some((w) => w.type === "manifest" && w.reason === "duplicate")).toBe(
      true,
    );
    expect(result.cleanupUnsafeLibraries).toContain(root);
  });

  it("bezieht blockierte AppIDs in die Duplikaterkennung ein", async () => {
    const { root, lib2 } = await buildFakeSteam();
    await writeFile(
      join(lib2, "steamapps/appmanifest_1493710.acf"),
      `"AppState"\n{\n\t"appid"\t\t"1493710"\n\t"name"\t\t"Proton Experimental Dup"\n\t"SizeOnDisk"\t\t"100"\n}\n`,
    );

    const result = await scanGames(
      nodeFs(),
      fakeSystem(),
      root,
      [root, lib2],
      () => "default",
      null,
    );

    expect(result.blockedAppIds.has(1493710)).toBe(true);
    expect(result.cleanupUnsafeLibraries).toEqual(expect.arrayContaining([root, lib2]));
    expect(
      result.warnings.some(
        (w) => w.type === "manifest" && w.reason === "duplicate" && w.appId === 1493710,
      ),
    ).toBe(true);
  });

  it("fremde datei in steamapps wird still übersprungen (147:11)", async () => {
    // eine nicht-manifest-datei (z.b. downloading_progress.json) erzeugt keine warnung
    const { root } = await buildFakeSteam();
    await writeFile(join(root, "steamapps/downloading_progress.json"), '{"foo":1}');

    const result = await scanGames(nodeFs(), fakeSystem(), root, [root], () => "default", null);

    // keine warnung für die json-datei
    expect(
      result.warnings.some(
        (w) => w.type === "manifest" && w.manifestName.includes("downloading_progress.json"),
      ),
    ).toBe(false);
    // normale spiele noch vorhanden
    expect(result.games.some((g) => g.appId === 570)).toBe(true);
  });

  it("manifest mit präfix/suffix im dateinamen wird übersprungen (19:21)", async () => {
    // xappmanifest_5.acf (präfix) und appmanifest_5.acf.bak (suffix) → kein match im MANIFEST_RE
    const { root } = await buildFakeSteam();
    await writeFile(
      join(root, "steamapps/xappmanifest_5.acf"),
      `"AppState"\n{\n\t"appid"\t\t"5"\n\t"name"\t\t"Prefix Game"\n}\n`,
    );
    await writeFile(
      join(root, "steamapps/appmanifest_5.acf.bak"),
      `"AppState"\n{\n\t"appid"\t\t"5"\n\t"name"\t\t"Suffix Game"\n}\n`,
    );

    const result = await scanGames(nodeFs(), fakeSystem(), root, [root], () => "default", null);

    // weder präfix noch suffix-datei erzeugt einen eintrag in games
    expect(result.games.some((g) => g.appId === 5)).toBe(false);
    // keine warnung für diese dateien (sie werden still geskippt)
    expect(
      result.warnings.some(
        (w) => w.type === "manifest" && w.manifestName.includes("xappmanifest_5"),
      ),
    ).toBe(false);
    expect(
      result.warnings.some(
        (w) => w.type === "manifest" && w.manifestName.includes("appmanifest_5.acf.bak"),
      ),
    ).toBe(false);
  });
});
