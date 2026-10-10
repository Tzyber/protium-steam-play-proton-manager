import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { availableBuiltinProtons, BLOCKLIST, blockReason } from "../../src/core/blocklist.js";
import { parseCompatToolMapping, readToolVdf } from "../../src/core/compatTools.js";
import { errText, parseError } from "../../src/core/errtext.js";
import { parseManifest } from "../../src/core/manifest.js";
import { joinPath } from "../../src/core/paths.js";
import { MAX_APP_ID, parseSafeAppId } from "../../src/core/types.js";
import { ensureSizeLimit, MAX_FILE_BYTES } from "../support/fakeSteam.js";

const acf = () => `"AppState"
{
	"appid"		"620"
	"name"		"Portal 2"
	"StateFlags"		"6"
	"SizeOnDisk"		"12345678"
}`;

describe("parseManifest", () => {
  it("liest felder", () => {
    const m = parseManifest(acf());
    expect(m).toEqual({
      appId: 620,
      name: "Portal 2",
      sizeBytes: 12345678,
      installdir: undefined,
    });
  });
  it("liest ein sicheres installdir aus AppState", () => {
    const m = parseManifest(
      '"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"Portal 2"\n\t"installdir"\t\t"Portal 2"\n}',
    );
    expect(m.installdir).toBe("Portal 2");
  });
  it.each([
    ["führende Nullen", '"001"'],
    ["Exponentenschreibweise", '"1e3"'],
    ["Dezimalpunkt", '"1.5"'],
  ])("bewahrt quoted installdir bei %s exakt", (_label, value) => {
    const m = parseManifest(
      `"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"Portal 2"\n\t"installdir"\t\t${value}\n}`,
    );
    expect(m.installdir).toBe(value.slice(1, -1));
  });
  it.each(["001", "1e3", "1.5"])("bewahrt unquoted installdir %s exakt", (value) => {
    const m = parseManifest(
      `"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"Portal 2"\n\t"installdir"\t\t${value}\n}`,
    );
    expect(m.installdir).toBe(value);
  });
  it.each([
    ["fehlend", undefined],
    ["leer", '""'],
    ["punkt", '"."'],
    ["parent-segment", '".."'],
    ["slash", '"Portal/2"'],
    ["backslash", '"Portal\\\\2"'],
    ["nul", `"Portal\0 2"`],
  ])("verwirft unsicheres installdir (%s)", (_label, value) => {
    const installdirLine = value === undefined ? "" : `\n\t"installdir"\t\t${value}`;
    const m = parseManifest(
      `"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"Portal 2"${installdirLine}\n}`,
    );
    expect(m.installdir).toBeUndefined();
  });
  it("leitet installdir nicht aus dem namen ab", () => {
    const m = parseManifest('"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"Portal 2"\n}');
    expect(m.installdir).toBeUndefined();
  });
  it("wirft bei fehlender appid", () => {
    expect(() => parseManifest('"AppState" { "name" "x" }')).toThrow();
  });
  it("wirft bei ungültiger appid (0, negativ, NaN, overflow)", () => {
    expect(() => parseManifest('"AppState"\n{\n\t"appid"\t\t"0"\n}')).toThrow(
      "manifest-invalid-appid",
    );
    expect(() => parseManifest('"AppState"\n{\n\t"appid"\t\t"-1"\n}')).toThrow(
      "manifest-invalid-appid",
    );
    expect(() => parseManifest('"AppState"\n{\n\t"appid"\t\t"abc"\n}')).toThrow(
      "manifest-invalid-appid",
    );
    expect(() => parseManifest('"AppState"\n{\n\t"appid"\t\t""\n}')).toThrow(
      "manifest-invalid-appid",
    );
    expect(() => parseManifest('"AppState"\n{\n\t"appid"\t\t"9007199254740992"\n}')).toThrow(
      "manifest-invalid-appid",
    );
  });
  it("akzeptiert führende Nullen in appid", () => {
    const m = parseManifest('"AppState"\n{\n\t"appid"\t\t"0570"\n}');
    expect(m.appId).toBe(570);
  });

  it('entschärft \\" und \\\\ im spielnamen', () => {
    const m = parseManifest(String.raw`"AppState"
{
	"appid"		"620"
	"name"		"Say \"Hi\" C:\\logs"
}`);
    expect(m.name).toBe(String.raw`Say "Hi" C:\logs`);
  });

  it("lässt 007 und true als spielnamen stehen", () => {
    expect(parseManifest('"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"007"\n}').name).toBe(
      "007",
    );
    expect(parseManifest('"AppState"\n{\n\t"appid"\t\t"44"\n\t"name"\t\t"true"\n}').name).toBe(
      "true",
    );
  });

  it("lässt einen gleichnamigen schlüssel im verschachtelten block den namen nicht überschreiben", () => {
    const m = parseManifest(`"AppState"
{
	"appid"		"620"
	"name"		"Portal 2"
	"UserConfig"
	{
		"name"		"Fremder Name"
	}
}`);
    expect(m.name).toBe("Portal 2");
  });

  it("lehnt die appid 0x2A ab", () => {
    expect(() => parseManifest('"AppState"\n{\n\t"appid"\t\t"0x2A"\n\t"name"\t\t"Hex"\n}')).toThrow(
      "manifest-invalid-appid",
    );
  });

  it.each([
    ["fehlend", undefined],
    ["leer", '""'],
    ["negativ", '"-1"'],
    ["dezimal", '"1.5"'],
    ["nichtnumerisch", '"abc"'],
    ["unsicher groß", '"9007199254740992"'],
  ])("hält SizeOnDisk bei %s unbekannt", (_label, sizeValue) => {
    const sizeLine = sizeValue === undefined ? "" : `\n\t"SizeOnDisk"\t\t${sizeValue}`;
    const m = parseManifest(`"AppState"\n{\n\t"appid"\t\t"620"${sizeLine}\n}`);
    expect(m.sizeBytes).toBeUndefined();
  });

  it("akzeptiert SizeOnDisk 0 als bekannten Wert", () => {
    const m = parseManifest('"AppState"\n{\n\t"appid"\t\t"620"\n\t"SizeOnDisk"\t\t"0"\n}');
    expect(m.sizeBytes).toBe(0);
  });

  it.each([
    ["dezimal", "1.5"],
    ["exponent", "1e3"],
    ["negativer nullwert", "-0"],
  ])("hält unquoted SizeOnDisk bei %s lexikalisch unbekannt", (_label, sizeValue) => {
    const m = parseManifest(`"AppState"\n{\n\t"appid"\t\t"620"\n\t"SizeOnDisk"\t\t${sizeValue}\n}`);
    expect(m.sizeBytes).toBeUndefined();
  });

  it("verwendet bei doppeltem SizeOnDisk den letzten gültigen Wert", () => {
    const m = parseManifest(
      '"AppState"\n{\n\t"appid"\t\t"620"\n\t"SizeOnDisk"\t\t"10"\n\t"SizeOnDisk"\t\t"20"\n}',
    );
    expect(m.sizeBytes).toBe(20);
  });

  it("macht einen gültigen SizeOnDisk durch einen ungültigen letzten Wert unbekannt", () => {
    const m = parseManifest(
      '"AppState"\n{\n\t"appid"\t\t"620"\n\t"SizeOnDisk"\t\t"10"\n\t"SizeOnDisk"\t\t"1e3"\n}',
    );
    expect(m.sizeBytes).toBeUndefined();
  });

  it("akzeptiert exakt die u32-Obergrenze und verwirft den nächsten Wert", () => {
    expect(parseSafeAppId("2147483647")).toBe(2147483647);
    expect(parseSafeAppId("2147483648")).toBe(2147483648);
    expect(parseSafeAppId("4294967295")).toBe(4294967295);
    expect(parseSafeAppId("4294967296")).toBeNull();
    expect(parseSafeAppId("999999999999999999999999")).toBeNull();
  });
});

describe("blocklist", () => {
  it("blockt bekannte proton-appid", () =>
    expect(blockReason(1493710, "Proton Experimental")).toBe("id"));
  it("blockt Legacy Steam Runtime über die exakte appid", () =>
    expect(blockReason(4690330, "Legacy Steam Runtime")).toBe("id"));
  it("blockt via namens-heuristik", () =>
    expect(blockReason(4242, "Steam Linux Runtime 3.0")).toBe("name-heuristic"));
  it("lässt echtes spiel durch", () => expect(blockReason(620, "Portal 2")).toBe(null));
});

// one source of truth: BLOCKLIST ist die kanonische tabelle. der dropdown-flow
// (GameDetailDrawer.compatOptions) liest via availableBuiltinProtons aus
// derselben liste. ein zukünftiger split, z. b. eine separate appId→toolName-map
// für das dropdown, würde diese invariant brechen und der test schlägt fehl.
describe("kanonische tabelle (blocklist ↔ dropdown-flow)", () => {
  it("jeder proton-builtin-eintrag erscheint mit identischem toolnamen im dropdown", () => {
    for (const entry of BLOCKLIST) {
      if (entry.category !== "proton-builtin") continue;
      const installed = new Set([entry.appId]);
      const dropdown = availableBuiltinProtons(installed);
      const match = dropdown.find((d) => d.internalName === entry.toolName);
      expect(
        match,
        `appId ${entry.appId} (${entry.label}) muss mit toolName "${entry.toolName}" im dropdown auftauchen`,
      ).toBeDefined();
      expect(match?.displayName).toBe(entry.label);
    }
  });

  it("kein dropdown-eintrag ohne korrespondierenden blocklist-eintrag", () => {
    // umgekehrte richtung: der dropdown darf nichts erfinden, was nicht in
    // BLOCKLIST steht (würde eine zweite tabelle für die dropdown-daten bedeuten).
    const builtinToolNames = new Set(
      BLOCKLIST.filter((e) => e.category === "proton-builtin").map((e) => e.toolName),
    );
    const allInstalled = new Set(
      BLOCKLIST.filter((e) => e.category === "proton-builtin").map((e) => e.appId),
    );
    const dropdown = availableBuiltinProtons(allInstalled);
    for (const d of dropdown) {
      expect(
        builtinToolNames.has(d.internalName),
        `dropdown liefert toolName "${d.internalName}", der nicht in BLOCKLIST steht`,
      ).toBe(true);
    }
  });
});

describe("parseCompatToolMapping (case-insensitive traversal)", () => {
  it("liest mapping trotz gemischter groß-/kleinschreibung", () => {
    const cfg = `"InstallConfigStore"
{
	"software"
	{
		"valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"620"
					{
						"name"		"GE-Proton9-27"
					}
					"570"
					{
						"name"		"proton_experimental"
					}
				}
			}
		}
	}
}`;
    const map = parseCompatToolMapping(cfg);
    expect(map.get(620)).toBe("GE-Proton9-27");
    expect(map.get(570)).toBe("proton_experimental");
    expect(map.size).toBe(2);
  });
  it("fehlender teilbaum → leere map", () => {
    expect(parseCompatToolMapping('"InstallConfigStore"\n{\n}').size).toBe(0);
  });

  // C-01: Number() liest auch "0x10" (16), "1e3" (1000) und "" (0); ein
  // solcher key darf nie als appId im mapping landen.
  it("ignoriert nicht-numerische keys statt sie als zahl zu lesen", () => {
    const cfg = `"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"0x10"
					{
						"name"	"hex"
					}
					"1e3"
					{
						"name"	"exp"
					}
					"620"
					{
						"name"	"echt"
					}
				}
			}
		}
	}
}`;
    const map = parseCompatToolMapping(cfg);
    expect([...map.entries()]).toEqual([[620, "echt"]]);
  });

  // C-01-Nachbesserung: eine reine ziffernprüfung hat keine obergrenze.
  // Number() macht aus einer 400-stelligen ziffernfolge Infinity, und
  // MAX_APP_ID + 1 liegt darüber; beides darf nicht als appId in die map
  // landen. Die gültigen ränder (u32::MAX und der shortcut-bereich ab 2^31)
  // müssen halten.
  it("weist ziffernstrings über MAX_APP_ID und Infinity ab", () => {
    const cfg = `"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"${"9".repeat(400)}"
					{
						"name"	"overflow"
					}
					"${MAX_APP_ID + 1}"
					{
						"name"	"ueber der grenze"
					}
					"${MAX_APP_ID}"
					{
						"name"	"obergrenze"
					}
					"2147483648"
					{
						"name"	"shortcut"
					}
				}
			}
		}
	}
}`;
    const mapping = parseCompatToolMapping(cfg);
    // Einzelprüfungen statt Array-Vergleich: die VDF-Bibliothek behält die
    // Dateireihenfolge, aber Object.keys zieht ganzzahl-index-artige Keys
    // ("2147483648" = 2^31) vor die übrigen, die Map-Reihenfolge ist also
    // nicht die Dateireihenfolge (Sonde 2026-09-28).
    expect(mapping.has(Infinity)).toBe(false);
    expect(mapping.size).toBe(2);
    expect(mapping.get(MAX_APP_ID)).toBe("obergrenze");
    expect(mapping.get(2147483648)).toBe("shortcut");
  });

  // "00" las Number("00") als 0 und traf damit den globalen default-slot.
  it("liest einen genullten key nicht als globalen default", () => {
    const cfg = `"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"00"
					{
						"name"	"kein-default"
					}
				}
			}
		}
	}
}`;
    const mapping = parseCompatToolMapping(cfg);
    expect(mapping.has(0)).toBe(false);
    expect(mapping.size).toBe(0);
  });

  // der key "0" ist die globale standard-zuordnung (scan/tools.ts liest
  // mapping.get(0)); er muss den filter überleben.
  it("behält den globalen default-key 0", () => {
    const cfg = `"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"0"
					{
						"name"	"proton-cachyos-slr"
					}
				}
			}
		}
	}
}`;
    expect(parseCompatToolMapping(cfg).get(0)).toBe("proton-cachyos-slr");
  });

  // führende nullen sind ziffern-rein und bleiben bewusst akzeptiert
  it("akzeptiert führende nullen (ziffern-reine keys)", () => {
    const cfg = `"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
					"007"
					{
						"name"	"bond"
					}
				}
			}
		}
	}
}`;
    expect(parseCompatToolMapping(cfg).get(7)).toBe("bond");
  });
});

describe("readToolVdf", () => {
  it('entschärft \\" und \\\\ in display_name', () => {
    const tool = readToolVdf(
      String.raw`"compatibilitytools"
{
	"compat_tools"
	{
		"tool"
		{
			"display_name"		"Say \"Hi\" C:\\logs"
		}
	}
}`,
      "fallback",
    );
    expect(tool).toEqual({ internalName: "tool", displayName: String.raw`Say "Hi" C:\logs` });
  });

  it("lässt 007 und true als display_name stehen", () => {
    const numeric = readToolVdf(
      `"compatibilitytools"\n{\n\t"compat_tools"\n\t{\n\t\t"tool"\n\t\t{\n\t\t\t"display_name"\t\t"007"\n\t\t}\n\t}\n}`,
      "fallback",
    );
    expect(numeric).toEqual({ internalName: "tool", displayName: "007" });

    const flag = readToolVdf(
      `"compatibilitytools"\n{\n\t"compat_tools"\n\t{\n\t\t"tool"\n\t\t{\n\t\t\t"display_name"\t\t"true"\n\t\t}\n\t}\n}`,
      "fallback",
    );
    expect(flag).toEqual({ internalName: "tool", displayName: "true" });
  });
});

describe("errText", () => {
  it("string-rejection (tauri invoke) bleibt erhalten", () => {
    expect(errText("scope-fehler: forbidden path")).toBe("scope-fehler: forbidden path");
  });
  it("Error → message", () => {
    expect(errText(new Error("kaputt"))).toBe("kaputt");
  });
  it("sonstiges → String()", () => {
    expect(errText(42)).toBe("42");
    expect(errText(null)).toBe("null");
    expect(errText(undefined)).toBe("undefined");
  });
  it("erkennt die write-gate-ablehnung am Code", () => {
    expect(parseError("steam-running").code).toBe("steam-running");
    expect(parseError("steam-running").kind).toBe("blocked");
    expect(parseError(new Error("scope-fehler")).code).toBe("unknown");
  });
  it("erkennt den bereits existierenden zielordner am Code", () => {
    expect(parseError("tool-already-exists: target directory").code).toBe("tool-already-exists");
    expect(parseError("install kaputt").code).toBe("unknown");
  });
});

describe("joinPath (path-traversal-rejection)", () => {
  it("verbietet .. in segmenten", () => {
    expect(() => joinPath("/home", "..", "etc")).toThrow("..");
  });

  it("verbietet .. am anfang", () => {
    expect(() => joinPath("/foo", "..")).toThrow("..");
  });

  it("verbietet .. in mehrteiligem segment", () => {
    expect(() => joinPath("/a/b", "c/../../etc")).toThrow("..");
  });

  it("erlaubt normale pfade", () => {
    expect(joinPath("/home/u", ".local", "share")).toBe("/home/u/.local/share");
  });

  it("erlaubt externe mount-pfade", () => {
    expect(joinPath("/run/media/user", "SteamLibrary")).toBe("/run/media/user/SteamLibrary");
    expect(joinPath("/mnt", "games")).toBe("/mnt/games");
  });
});

describe("ensureSizeLimit (M4.3, größen-cap für reads)", () => {
  it("unter dem limit → kein throw", () => {
    expect(() => ensureSizeLimit(1024)).not.toThrow();
    expect(() => ensureSizeLimit(MAX_FILE_BYTES)).not.toThrow();
  });

  it("über dem limit → wirft", () => {
    expect(() => ensureSizeLimit(MAX_FILE_BYTES + 1)).toThrow(/zu groß/);
  });
});

// vertragstest S-03: die datei ist der byte-genaue output von
// extract_vdf_block (src-tauri/src/commands/vdf_patch_tests.rs,
// cross_parser_mapping_ist_echter_rust_output). So kommt config.vdf im
// frontend an: nur das mapping, ohne login-tokens.
describe("parseCompatToolMapping liest das reduzierte config.vdf", () => {
  const RUST_OUTPUT = readFileSync(
    resolve(import.meta.dirname, "../fixtures/cross-parser-mapping-expected.vdf"),
    "utf8",
  );

  it("liefert globale und spielweise zuordnung", () => {
    expect(parseCompatToolMapping(RUST_OUTPUT)).toEqual(
      new Map([
        [0, "proton_experimental"],
        [620, "GE-Proton9-1"],
      ]),
    );
  });

  it("enthält keine login-daten", () => {
    for (const secret of ["ConnectCache", "geheim", "Accounts", "SentryFile"]) {
      expect(RUST_OUTPUT).not.toContain(secret);
    }
  });
});
