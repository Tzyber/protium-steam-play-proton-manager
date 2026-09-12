import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findActiveUser,
  isLocalConfigParseable,
  readAppFields,
} from "../../src/core/localconfig.js";
import { getVdfValue, VdfPatchError } from "../../src/core/vdfpatch.js";
import { buildFakeSteam, nodeFs } from "../support/fakeSteam.js";

const APPS_PATH = ["UserLocalConfigStore", "Software", "Valve", "Steam", "Apps"];

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

  it("bleibt bei doppeltem app-key mit dem einzelreader deckungsgleich", () => {
    // der erste block hat keine der angefragten felder: der sammelreader muss
    // trotzdem denselben block sehen wie `getVdfValue` (first-match).
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
						"Playtime"		"10"
					}
					"620"
					{
						"LaunchOptions"		"PROTON_LOG=1 %command%"
					}
				}
			}
		}
	}
}
`;
    expect(getVdfValue(text, [...APPS_PATH, "620", "LaunchOptions"])).toBeUndefined();
    expect(readAppFields(text)).toEqual({
      launchOptions: new Map(),
      lastPlayed: new Map(),
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
  it("besteht einen defekt unterhalb des pfads, den der sammelreader dann meldet", () => {
    expect(isLocalConfigParseable(DANGLING_KEY_IN_APP_BLOCK)).toBeNull();
    // der defekte block trägt keine werte bei, der fehler kommt als firstError.
    expect(readAppFields(DANGLING_KEY_IN_APP_BLOCK)).toEqual({
      launchOptions: new Map(),
      lastPlayed: new Map(),
      firstError: 'key "Dangling" ohne wert',
    });
  });

  it("meldet einen lexikalischen defekt der ganzen datei", () => {
    const text = `"UserLocalConfigStore"\n{\n\t"LaunchOptions"\t\t"ohne ende`;
    expect(isLocalConfigParseable(text)).toEqual({ detail: "unterminierter string" });
    expect(() => readAppFields(text)).toThrow(new VdfPatchError("unterminierter string"));
  });
});
