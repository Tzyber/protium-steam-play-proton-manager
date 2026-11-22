import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProtiumError } from "../../src/core/errors.js";
import {
  childKeys,
  getVdfChildFieldValues,
  getVdfValue,
  isBlock,
  VdfPatchError,
} from "../../src/core/vdfRead.js";

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

  it("meldet ein überschrittenes token-cap als vdf-limit", () => {
    // P12a: der cap bricht als unreadable/vdf-limit ab und nicht als
    // VdfPatchError; der code ist der vertrag zur oberfläche.
    const text = `"Root"\n{\n\t"Key"\t\t"value"\n}\n${"{}".repeat(128)}`;
    let caught: unknown;
    try {
      getVdfValue(text, ["Root", "Key"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProtiumError);
    expect(caught).toMatchObject({ kind: "unreadable", code: "vdf-limit" });
  });

  it("nennt token- und tiefen-cap im detail", () => {
    // P12a: beide caps brechen mit demselben code ab; unterscheidbar sind sie
    // nur über das detail. ohne diesen pin bliebe eine vertauschung der beiden
    // meldungen unsichtbar.
    const detailOf = (text: string): unknown => {
      try {
        getVdfValue(text, ["Root", "Key"]);
      } catch (error) {
        return error instanceof ProtiumError ? error.detail : error;
      }
      return "kein fehler";
    };
    expect(detailOf(`"Root"\n{\n\t"Key"\t\t"value"\n}\n${"{}".repeat(128)}`)).toBe(
      "vdf token limit",
    );
    // 257 öffnungen: der tiefen-cap greift vor dem token-cap (513 tokens bei
    // 1542 zeichen).
    expect(detailOf('"k"\n{\n'.repeat(257))).toBe("vdf depth limit");
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

describe("childKeys und isBlock", () => {
  it("liefert direkte kind-keys in quellreihenfolge (blöcke und skalare) und dedupliziert case-insensitiv", () => {
    const text = `"Root"
{
\t"First"\t\t"1"
\t"Sub"
\t{
\t\t"inner"\t\t"x"
\t}
\t"first"\t\t"2"
\t"SUB"
\t{
\t\t"inner"\t\t"y"
\t}
\t"Last"\t\t"3"
}`;
    expect(childKeys(text, ["root"])).toEqual(["First", "Sub", "Last"]);
    expect(childKeys(text, [])).toEqual(["Root"]);
  });

  it("liefert [] bei fehlendem oder skalarem pfad", () => {
    const text = `"Root"\n{\n\t"Scalar"\t\t"v"\n}\n`;
    expect(childKeys(text, ["Missing"])).toEqual([]);
    expect(childKeys(text, ["Root", "Scalar"])).toEqual([]);
    expect(childKeys("", ["Root"])).toEqual([]);
  });

  it("nimmt bei doppeltem elternblock den ersten block für childKeys und isBlock", () => {
    const text = `"Apps"
{
\t"onlyFirst"\t\t"1"
}
"apps"
{
\t"onlySecond"\t\t"2"
\t"Block"
\t{
\t}
}`;
    expect(childKeys(text, ["Apps"])).toEqual(["onlyFirst"]);
    expect(isBlock(text, ["Apps", "Block"])).toBe(false);
    expect(getVdfValue(text, ["Apps", "onlyFirst"])).toBe("1");
    expect(getVdfValue(text, ["Apps", "onlySecond"])).toBeUndefined();
  });

  it("prüft mit isBlock blöcke vs. skalare/fehlende pfade und validiert den blockinhalt", () => {
    const text = `"AppState"\n{\n\t"appid"\t\t"620"\n\t"Nested"\n\t{\n\t\t"a"\t\t"1"\n\t}\n}`;
    expect(isBlock(text, ["appstate"])).toBe(true);
    expect(isBlock(text, ["AppState", "nested"])).toBe(true);
    expect(isBlock(text, ["AppState", "appid"])).toBe(false);
    expect(isBlock(text, ["Missing"])).toBe(false);
    expect(isBlock(text, [])).toBe(false);

    expect(() => isBlock('"AppState"\n{\n\t"Dangling"\n}', ["AppState"])).toThrow(VdfPatchError);
  });

  it("meldet token-/tiefen-cap auch in childKeys und isBlock als vdf-limit", () => {
    const overTokens = `"Root"\n{\n\t"Key"\t\t"value"\n}\n${"{}".repeat(128)}`;
    expect(() => childKeys(overTokens, ["Root"])).toThrow(ProtiumError);
    expect(() => isBlock(overTokens, ["Root"])).toThrow(ProtiumError);
    expect(() => childKeys('"k"\n{\n'.repeat(257), ["k"])).toThrow("vdf-limit");
  });
});

describe("first-wins, rohstrings und prototyp-sicherheit", () => {
  it("resolviert doppelte keys mit first-wins und lässt zahlen-/bool-strings unverändert", () => {
    const text = `"Root"
{
\t"num"\t\t"007"
\t"flag"\t\t"true"
\t"dup"\t\t"first"
\t"DUP"\t\t"second"
\t"literal"
\t{
\t\t"proto"\t\t"__proto__"
\t\t"ctor"\t\t"constructor"
\t\t"prototype"\t\t"prototype"
\t}
}`;
    expect(getVdfValue(text, ["Root", "num"])).toBe("007");
    expect(getVdfValue(text, ["Root", "flag"])).toBe("true");
    expect(getVdfValue(text, ["Root", "dup"])).toBe("first");
    expect(getVdfValue(text, ["Root", "literal", "proto"])).toBe("__proto__");
    expect(getVdfValue(text, ["Root", "literal", "ctor"])).toBe("constructor");
    expect(getVdfValue(text, ["Root", "literal", "prototype"])).toBe("prototype");
  });

  it.each([
    [
      "__proto__",
      '"root"\n{\n\t"__proto__"\n\t{\n\t\t"polluted"\t\t"yes"\n\t}\n\t"normal"\t\t"ok"\n}',
    ],
    ["constructor", '"constructor"\n{\n\t"polluted"\t\t"yes"\n}\n"normal"\t\t"ok"'],
    ["prototype", 'prototype\n{\n\t"polluted"\t\t"yes"\n}\n"normal"\t\t"ok"'],
    [
      "toString",
      'root\n{\n\t"toString" [$WIN32]\n\t{\n\t\t"leak"\t\t"yes"\n\t}\n\t"normal"\t\t"ok"\n}',
    ],
    [
      "verschachtelte kette",
      '"toString" "X"\n{\n\t"constructor"\n\t{\n\t\t"prototype"\n\t\t{\n\t\t\t"apply"\t\t"yes"\n\t\t}\n\t}\n}\n"normal"\t\t"ok"',
    ],
    ["__proto__ null", '"a"\n{\n\t"__proto__"\t\t"null"\n\t"normal"\t\t"ok"\n}'],
  ])("lässt bei gefährlichem key '%s' keine globale mutation zu", (_name, text) => {
    const before = Object.getOwnPropertyNames(Object.prototype).join(",");
    const protoSnapshot = Object.getPrototypeOf(Object.prototype);
    const fnApply = Function.prototype.apply;

    try {
      childKeys(text, []);
      getVdfValue(text, ["normal"]);
      isBlock(text, ["__proto__"]);
    } catch {
      // struktureller fehler je nach eingabe zulässig, globale objekte bleiben unberührt
    }

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype.toString as unknown as Record<string, unknown>).leak).toBeUndefined();
    expect(Function.prototype.apply).toBe(fnApply);
    expect(Object.getPrototypeOf(Object.prototype)).toBe(protoSnapshot);
    expect(Object.getOwnPropertyNames(Object.prototype).join(",")).toBe(before);
  });

  it("lehnt mehrzeilige offene quotes in allen vdfRead-einstiegen ab (S-01)", () => {
    const open = '"AppState"\n{\n\t"name"\t"offen\n}\n';
    expect(() => getVdfValue(open, ["AppState", "name"])).toThrow("unterminierter string");
    expect(() => childKeys(open, ["AppState"])).toThrow("unterminierter string");
    expect(() => isBlock(open, ["AppState"])).toThrow("unterminierter string");
  });

  // Unter Stryker laufen die tests mit coverage-instrumentation je zeichen (~1.17s > 1s).
  // Der deterministische S-01-test oben bleibt aktiv; die wanduhr-messung läuft regulär.
  const underMutation = process.env.STRYKER_MUTATOR_WORKER !== undefined;

  it.skipIf(underMutation)("bricht bei großen offenen werten linear ab (S-01)", () => {
    const text = `"AppState"\n{\n\t"name"\t"${"x\n".repeat(200_000)}}\n`;
    const start = performance.now();
    expect(() => getVdfValue(text, ["AppState", "name"])).toThrow("unterminierter string");
    expect(() => isBlock(text, ["AppState"])).toThrow("unterminierter string");
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("cross-parser-vertrag Rust -> vdfRead", () => {
  const RUST_OUTPUT = readFileSync(
    resolve(import.meta.dirname, "../fixtures/cross-parser-expected.vdf"),
    "utf8",
  );
  const APPS = ["UserLocalConfigStore", "Software", "Valve", "Steam", "Apps"];

  it("parst den rust-output über childKeys, isBlock und getVdfValue verlustfrei", () => {
    expect(isBlock(RUST_OUTPUT, APPS)).toBe(true);
    expect(childKeys(RUST_OUTPUT, APPS)).toEqual(["620", "730", "1091500"]);
    expect(getVdfValue(RUST_OUTPUT, [...APPS, "620", "LastPlayed"])).toBeUndefined();
    expect(getVdfValue(RUST_OUTPUT, [...APPS, "620", "LaunchOptions"])).toBe(
      'PROTON_LOG=1 MANGOHUD_CONFIG="fps,gpu,ram" %command% --skip-launcher',
    );
    expect(getVdfValue(RUST_OUTPUT, [...APPS, "1091500", "LaunchOptions"])).toBe(
      'WINEDLLOVERRIDES="dinput8=n,b" PROTON_LOG_DIR=Z:\\home\\logs gamemoderun %command%',
    );
    expect(getVdfValue(RUST_OUTPUT, [...APPS, "730", "LaunchOptions"])).toBe("-novid -high");
  });
});
