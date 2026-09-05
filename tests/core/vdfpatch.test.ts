import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getVdfValue, VdfPatchError } from "../../src/core/vdfpatch.js";

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
const GOLDEN = readFileSync(`${process.cwd()}/tests/fixtures/text-vdf-golden.vdf`, "utf8");

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
