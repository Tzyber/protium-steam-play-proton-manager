import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findActiveUser,
  isLocalConfigParseable,
  readAllLaunchOptions,
  readAppFields,
  readLaunchOptions,
} from "../../src/core/localconfig.js";
import { VdfPatchError } from "../../src/core/vdfpatch.js";
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
  expect(readAllLaunchOptions(text)).toEqual({
    values: new Map([[620, "gamemoderun %command%"]]),
    firstError: null,
  });
});

describe("readAppFields", () => {
  const TWO_APPS = `"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"Apps"
				{
					"620"
					{
						"LaunchOptions"		"gamemoderun %command%"
						"LastPlayed"		"1757000000"
					}
					"730"
					{
						"LastPlayed"		"0"
					}
					"nicht-numerisch"
					{
						"LaunchOptions"		"ignoriert %command%"
					}
				}
			}
		}
	}
}
`;

  it("liest startoptionen und LastPlayed in einem lauf", () => {
    expect(readAppFields(TWO_APPS)).toEqual({
      launchOptions: new Map([[620, "gamemoderun %command%"]]),
      lastPlayed: new Map([
        [620, "1757000000"],
        [730, "0"],
      ]),
      firstError: null,
    });
  });

  it("meldet einen defekten fremdblock und behält die intakten werte", () => {
    const text = `"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"Apps"
				{
					"620"
					{
						"LaunchOptions"		"intact %command%"
						"LastPlayed"		"1757000000"
					}
					"730"
					{
						"LastPlayed"		"1"
						"Dangling"
					}
				}
			}
		}
	}
}
`;
    expect(readAppFields(text)).toEqual({
      launchOptions: new Map([[620, "intact %command%"]]),
      lastPlayed: new Map([[620, "1757000000"]]),
      firstError: 'key "Dangling" ohne wert',
    });
  });
});

// C-1: die vorab-probe prüft nur die ebenen des abgefragten pfads. ein defekt
// im app-block selbst besteht sie, erst der per-spiel-read wirft — deshalb
// fängt `scanGames` diesen wurf zusätzlich pro spiel ab.
const DANGLING_KEY_IN_APP_BLOCK = `"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"Apps"
				{
					"620"
					{
						"LaunchOptions"		"gamemoderun %command%"
						"Dangling"
					}
				}
			}
		}
	}
}
`;

describe("localconfig-strukturprobe", () => {
  it("besteht einen defekt unterhalb des pfads, den der per-spiel-read dann wirft", () => {
    expect(isLocalConfigParseable(DANGLING_KEY_IN_APP_BLOCK)).toBeNull();
    expect(() => readLaunchOptions(DANGLING_KEY_IN_APP_BLOCK, 620)).toThrow(
      new VdfPatchError('key "Dangling" ohne wert'),
    );
    // einmal-lesen überspringt den defekten block und meldet den fehler statt zu werfen.
    expect(readAllLaunchOptions(DANGLING_KEY_IN_APP_BLOCK)).toEqual({
      values: new Map(),
      firstError: 'key "Dangling" ohne wert',
    });
  });

  it("meldet einen lexikalischen defekt der ganzen datei", () => {
    const text = `"UserLocalConfigStore"\n{\n\t"LaunchOptions"\t\t"ohne ende`;
    expect(isLocalConfigParseable(text)).toEqual({ detail: "unterminierter string" });
    expect(() => readAllLaunchOptions(text)).toThrow(new VdfPatchError("unterminierter string"));
  });
});
