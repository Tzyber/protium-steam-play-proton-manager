import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getVdfChildFieldValues, getVdfValue, VdfPatchError } from "../../src/core/vdfpatch.js";

const LOCALCONFIG = `"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				// zuletzt gespielt
				"LastPlayed"		"620"
				"Apps"
				{
					"620"
					{
						"LaunchOptions"		"gamemoderun %command%"
					}
				}
			}
		}
	}
}
`;

const LAUNCH_620 = ["UserLocalConfigStore", "Software", "Valve", "Steam", "Apps", "620"];
// Der pfad haengt am dateistandort, nicht am arbeitsverzeichnis (T-11).
const GOLDEN = readFileSync(
  resolve(import.meta.dirname, "../fixtures/text-vdf-golden.vdf"),
  "utf8",
);

describe("getVdfValue", () => {
  it("liest einen bestehenden wert", () => {
    expect(getVdfValue(LOCALCONFIG, [...LAUNCH_620, "LaunchOptions"])).toBe(
      "gamemoderun %command%",
    );
  });

  it("liefert bei unbekanntem pfad undefined", () => {
    expect(getVdfValue(LOCALCONFIG, [...LAUNCH_620, "NichtDa"])).toBeUndefined();
    expect(getVdfValue(LOCALCONFIG, ["UserLocalConfigStore", "NichtDa", "x"])).toBeUndefined();
  });

  it("liefert bei einem block-pfad undefined", () => {
    expect(getVdfValue(LOCALCONFIG, LAUNCH_620)).toBeUndefined();
  });

  it("navigiert case-insensitiv", () => {
    const lower = LOCALCONFIG.replace('"Software"', '"software"');
    expect(getVdfValue(lower, [...LAUNCH_620, "LaunchOptions"])).toBe("gamemoderun %command%");
  });

  it("liest escaped quotes und backslashes als originalwert", () => {
    const text = `"Root"\n{\n\t"Key"\t\t"MANGOHUD_CONFIG=\\"fps\\" PROTON_LOG_DIR=C:\\\\logs"\n}\n`;
    expect(getVdfValue(text, ["Root", "Key"])).toBe(
      'MANGOHUD_CONFIG="fps" PROTON_LOG_DIR=C:\\logs',
    );
  });

  it("behandelt CRLF-zeilenenden", () => {
    const text = `"Root"\r\n{\r\n\t"Key"\t\t"value"\r\n}\r\n`;
    expect(getVdfValue(text, ["Root", "Key"])).toBe("value");
  });

  it("überspringt block-kommentare", () => {
    const text = `"Root"\n{\n\t/* kommentar */\n\t"Key"\t\t"value"\n}\n`;
    expect(getVdfValue(text, ["Root", "Key"])).toBe("value");
  });

  it("behandelt bare tokens wie strings", () => {
    expect(getVdfValue("Root\n{\n\tKey\t\tvalue\n}\n", ["Root", "Key"])).toBe("value");
  });

  it("ignoriert conditional-marker nach einem wert und vor einem eintrag", () => {
    const text = `"Root"\n{\n\t"Key"\t\t"value"\t[linux]\n\t[windows]\n\t"Other"\t\t"other"\n}\n`;
    expect(getVdfValue(text, ["Root", "Key"])).toBe("value");
    expect(getVdfValue(text, ["Root", "Other"])).toBe("other");
  });
});

const APPS_PATH = ["UserLocalConfigStore", "Software", "Valve", "Steam", "Apps"];

const appsText = (body: string): string => `"UserLocalConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"Apps"
\t\t\t\t{
${body}\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

describe("getVdfChildFieldValues", () => {
  const FIELDS = ["LaunchOptions", "LastPlayed"] as const;

  it("liefert eine leere map ohne fehler, wenn der pfad fehlt", () => {
    const text = `"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t}\n}\n`;
    expect(getVdfChildFieldValues(text, APPS_PATH, FIELDS)).toEqual({
      values: new Map(),
      firstError: null,
    });
  });

  it("liefert eine leere map, wenn ein pfadsegment skalar ist", () => {
    const text = `"UserLocalConfigStore"\n{\n\t"Software"\t\t"scalar"\n}\n`;
    expect(getVdfChildFieldValues(text, APPS_PATH, FIELDS)).toEqual({
      values: new Map(),
      firstError: null,
    });
  });

  it("liest mehrere leafs eines app-blocks in einem lauf", () => {
    const text = appsText(
      `\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LaunchOptions"\t\t"gamemoderun %command%"\n\t\t\t\t\t\t"LastPlayed"\t\t"1757000000"\n\t\t\t\t\t}\n`,
    );
    const result = getVdfChildFieldValues(text, APPS_PATH, FIELDS);
    expect(result.firstError).toBeNull();
    expect(result.values.get("620")).toEqual(
      new Map([
        ["LaunchOptions", "gamemoderun %command%"],
        ["LastPlayed", "1757000000"],
      ]),
    );
  });

  it("nimmt nur die vorhandenen leafs eines blocks auf", () => {
    const text = appsText(
      `\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\t\t"1757000000"\n\t\t\t\t\t}\n`,
    );
    const result = getVdfChildFieldValues(text, APPS_PATH, FIELDS);
    expect(result.firstError).toBeNull();
    expect(result.values.get("620")).toEqual(new Map([["LastPlayed", "1757000000"]]));
    expect(result.values.get("620")?.has("LaunchOptions")).toBe(false);
  });

  it("überspringt einen block-wert als leaf", () => {
    const text = appsText(
      `\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\t"nested"\t\t"x"\n\t\t\t\t\t\t}\n\t\t\t\t\t\t"LaunchOptions"\t\t"ok %command%"\n\t\t\t\t\t}\n`,
    );
    const result = getVdfChildFieldValues(text, APPS_PATH, FIELDS);
    expect(result.firstError).toBeNull();
    expect(result.values.get("620")).toEqual(new Map([["LaunchOptions", "ok %command%"]]));
  });

  it("nimmt bei doppeltem app-key nur den ersten block", () => {
    const text = appsText(
      `\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\t\t"1"\n\t\t\t\t\t}\n` +
        `\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LaunchOptions"\t\t"second %command%"\n\t\t\t\t\t\t"LastPlayed"\t\t"2"\n\t\t\t\t\t}\n`,
    );
    const result = getVdfChildFieldValues(text, APPS_PATH, FIELDS);
    expect(result.firstError).toBeNull();
    expect(result.values.size).toBe(1);
    expect(result.values.get("620")).toEqual(new Map([["LastPlayed", "1"]]));
  });

  it("nimmt bei doppeltem app-key den ersten block auch ohne angefragtes feld", () => {
    // der erste block ist gesehen, gleich ob er einen der leafs enthält: sonst
    // liefert der sammelreader einen späteren block als `getVdfValue`.
    const text = appsText(
      `\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"Playtime"\t\t"10"\n\t\t\t\t\t}\n` +
        `\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LaunchOptions"\t\t"PROTON_LOG=1 %command%"\n\t\t\t\t\t}\n`,
    );
    const result = getVdfChildFieldValues(text, APPS_PATH, FIELDS);
    expect(result.firstError).toBeNull();
    expect(result.values.has("620")).toBe(false);
    expect(getVdfValue(text, [...LAUNCH_620, "LaunchOptions"])).toBeUndefined();
  });

  it("behandelt doppelte app-keys mit anderer schreibweise als denselben key", () => {
    const text = appsText(
      `\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"Playtime"\t\t"10"\n\t\t\t\t\t}\n` +
        `\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LaunchOptions"\t\t"PROTON_LOG=1 %command%"\n\t\t\t\t\t}\n`,
    );
    const result = getVdfChildFieldValues(text, APPS_PATH, FIELDS);
    expect(result.firstError).toBeNull();
    expect(result.values.has("620")).toBe(false);
  });

  it("meldet den defekt eines fremden blocks und liefert die übrigen werte", () => {
    const text = appsText(
      `\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LaunchOptions"\t\t"intact %command%"\n\t\t\t\t\t\t"LastPlayed"\t\t"1757000000"\n\t\t\t\t\t}\n` +
        `\t\t\t\t\t"730"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\t\t"1"\n\t\t\t\t\t\t"Dangling"\n\t\t\t\t\t}\n`,
    );
    const result = getVdfChildFieldValues(text, APPS_PATH, FIELDS);
    expect(result.values.get("620")).toEqual(
      new Map([
        ["LaunchOptions", "intact %command%"],
        ["LastPlayed", "1757000000"],
      ]),
    );
    expect(result.values.has("730")).toBe(false);
    expect(result.firstError).toBe('key "Dangling" ohne wert');
  });
});

describe("VDF-parser-fehler", () => {
  it("meldet einen unterminierten string", () => {
    const text = `"Root"\n{\n\t"Key"\t\t"wert ohne schlussquote`;
    expect(() => getVdfValue(text, ["Root", "Key"])).toThrow(
      new VdfPatchError("unterminierter string"),
    );
  });

  it("meldet einen unterminierten block-kommentar", () => {
    const text = `"Root"\n{\n\t/* nicht geschlossen\n\t"Key"\t\t"value"\n}\n`;
    expect(() => getVdfValue(text, ["Root", "Key"])).toThrow(VdfPatchError);
  });

  it("meldet einen key ohne wert", () => {
    expect(() => getVdfValue('"Key"', ["Key"])).toThrow(new VdfPatchError('key "Key" ohne wert'));
  });

  it("meldet eine schließende klammer als wert", () => {
    const text = `"Root"\n{\n\t"Key"\n}\n`;
    expect(() => getVdfValue(text, ["Root", "Key"])).toThrow(
      new VdfPatchError('key "Key" ohne wert'),
    );
  });

  it("meldet unbalancierte klammern", () => {
    const text = `"Root"\n{\n\t"Key"\t\t"value"\n`;
    expect(() => getVdfValue(text, ["Root", "Key"])).toThrow(VdfPatchError);
  });
});

describe("text-vdf-golden-fixture", () => {
  it("liest escaped launch-options und den conditional-marker", () => {
    const launch620 = [...LAUNCH_620, "LaunchOptions"];
    const launch570 = ["UserLocalConfigStore", "Software", "Valve", "Steam", "Apps", "570"];
    expect(getVdfValue(GOLDEN, launch620)).toBe(
      'MANGOHUD_CONFIG="fps,cpu" PROTON_LOG_DIR=C:\\logs %command%',
    );
    expect(getVdfValue(GOLDEN, [...launch570, "LastPlayed"])).toBe("570");
  });

  it("liest bare tokens und lässt fehlende werte undefined", () => {
    expect(getVdfValue(GOLDEN, ["UserLocalConfigStore", "BareKey"])).toBe("bare-value");
    expect(getVdfValue(GOLDEN, ["UserLocalConfigStore", "BareTokenKey"])).toBe("token-value");
    expect(getVdfValue(GOLDEN, ["UserLocalConfigStore", "Missing"])).toBeUndefined();
  });
});
