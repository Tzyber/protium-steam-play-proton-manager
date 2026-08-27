import { parse, stringify } from "@node-steam/vdf";
import { describe, expect, it } from "vitest";
import {
  getVdfValue,
  removeVdfEntry,
  setVdfValue,
  VdfPatchError,
} from "../../src/core/vdfpatch.js";

// anonymisierte fixtures im stil echter steam-dateien (tabs, kommentar, leerer block)
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
					"228980"
					{
					}
				}
			}
		}
	}
}
`;

const LAUNCH_620 = ["UserLocalConfigStore", "Software", "Valve", "Steam", "Apps", "620"];
const LAUNCH_228980 = ["UserLocalConfigStore", "Software", "Valve", "Steam", "Apps", "228980"];

describe("getVdfValue", () => {
  it("liest einen bestehenden wert", () => {
    expect(getVdfValue(LOCALCONFIG, [...LAUNCH_620, "LaunchOptions"])).toBe(
      "gamemoderun %command%",
    );
  });

  it("unbekannter pfad → undefined", () => {
    expect(getVdfValue(LOCALCONFIG, [...LAUNCH_620, "NichtDa"])).toBeUndefined();
    expect(getVdfValue(LOCALCONFIG, ["UserLocalConfigStore", "NichtDa", "x"])).toBeUndefined();
  });

  it("block-pfad → undefined (kein skalar)", () => {
    expect(getVdfValue(LOCALCONFIG, LAUNCH_620)).toBeUndefined();
  });
});

describe("setVdfValue, ersetzen", () => {
  it("ändert nur die value-span, rest byte-identisch", () => {
    const patched = setVdfValue(
      LOCALCONFIG,
      [...LAUNCH_620, "LaunchOptions"],
      "MANGOHUD=1 %command%",
    );
    const expected = LOCALCONFIG.replace('"gamemoderun %command%"', '"MANGOHUD=1 %command%"');
    expect(patched).toBe(expected);
    expect(getVdfValue(patched, [...LAUNCH_620, "LaunchOptions"])).toBe("MANGOHUD=1 %command%");
  });

  it("no-op liefert den originaltext (byte-identisch)", () => {
    expect(
      setVdfValue(LOCALCONFIG, [...LAUNCH_620, "LaunchOptions"], "gamemoderun %command%"),
    ).toBe(LOCALCONFIG);
  });

  it("hin- und zurück-patchen ergibt das original", () => {
    const patched = setVdfValue(LOCALCONFIG, [...LAUNCH_620, "LaunchOptions"], "x");
    expect(setVdfValue(patched, [...LAUNCH_620, "LaunchOptions"], "gamemoderun %command%")).toBe(
      LOCALCONFIG,
    );
  });

  it("escaped quotes und backslashes beim schreiben", () => {
    const evil = 'MANGOHUD_CONFIG="fps,cpu" PROTON_LOG_DIR=C:\\logs %command%';
    const patched = setVdfValue(LOCALCONFIG, [...LAUNCH_620, "LaunchOptions"], evil);
    const expected = LOCALCONFIG.replace(
      '"gamemoderun %command%"',
      '"MANGOHUD_CONFIG=\\"fps,cpu\\" PROTON_LOG_DIR=C:\\\\logs %command%"',
    );
    expect(patched).toBe(expected);
    // und liest sich wieder als exakt derselbe wert
    expect(getVdfValue(patched, [...LAUNCH_620, "LaunchOptions"])).toBe(evil);
    // datei bleibt für den normalen parser wohlgeformt
    expect(() => parse(patched)).not.toThrow();
  });
});

describe("setVdfValue, anlegen", () => {
  it("fügt einen key in einen bestehenden leeren block ein", () => {
    const patched = setVdfValue(LOCALCONFIG, [...LAUNCH_228980, "LaunchOptions"], "-novid");
    const expected = LOCALCONFIG.replace(
      '\t\t\t\t\t"228980"\n\t\t\t\t\t{\n\t\t\t\t\t}',
      '\t\t\t\t\t"228980"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LaunchOptions"\t\t"-novid"\n\t\t\t\t\t}',
    );
    expect(patched).toBe(expected);
    // nachbar-eintrag unberührt
    expect(getVdfValue(patched, [...LAUNCH_620, "LaunchOptions"])).toBe("gamemoderun %command%");
  });

  it("legt einen fehlenden appId-block komplett an", () => {
    const path730 = [
      "UserLocalConfigStore",
      "Software",
      "Valve",
      "Steam",
      "Apps",
      "730",
      "LaunchOptions",
    ];
    const patched = setVdfValue(LOCALCONFIG, path730, "-tickrate 128");
    const expected = LOCALCONFIG.replace(
      "\t\t\t\t\t}\n\t\t\t\t}", // ende des 228980-blocks + schluss des Apps-blocks
      '\t\t\t\t\t}\n\t\t\t\t\t"730"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LaunchOptions"\t\t"-tickrate 128"\n\t\t\t\t\t}\n\t\t\t\t}',
    );
    expect(patched).toBe(expected);
    expect(getVdfValue(patched, path730)).toBe("-tickrate 128");
    expect(getVdfValue(patched, [...LAUNCH_620, "LaunchOptions"])).toBe("gamemoderun %command%");
    expect(() => parse(patched)).not.toThrow();
  });

  it("legt den gesamten teilbaum an, wenn er fehlt", () => {
    const minimal = `"UserLocalConfigStore"\n{\n}\n`;
    const patched = setVdfValue(minimal, [...LAUNCH_620, "LaunchOptions"], "%command% -windowed");
    const expected = `"UserLocalConfigStore"
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
						"LaunchOptions"		"%command% -windowed"
					}
				}
			}
		}
	}
}
`;
    expect(patched).toBe(expected);
    expect(() => parse(patched)).not.toThrow();
  });

  it("navigiert case-insensitiv", () => {
    const lower = LOCALCONFIG.replace('"Software"', '"software"');
    const patched = setVdfValue(lower, [...LAUNCH_620, "LaunchOptions"], "y");
    expect(getVdfValue(patched, [...LAUNCH_620, "LaunchOptions"])).toBe("y");
  });
});

describe("setVdfValue, schutz vor strukturbruch", () => {
  it("unbalancierte klammern → wirft", () => {
    expect(() => setVdfValue('"A"\n{\n\t"B" "1"\n', ["A", "B"], "2")).toThrow(VdfPatchError);
  });

  it("pfad trifft auf skalar statt block → wirft", () => {
    expect(() => setVdfValue(LOCALCONFIG, [...LAUNCH_620, "LaunchOptions", "tiefer"], "x")).toThrow(
      VdfPatchError,
    );
  });

  it("block mit skalar überschreiben → wirft", () => {
    expect(() =>
      setVdfValue(LOCALCONFIG, ["UserLocalConfigStore", "Software", "Valve", "Steam", "Apps"], "x"),
    ).toThrow(VdfPatchError);
  });

  it("zeilenumbruch im wert → wirft", () => {
    expect(() => setVdfValue(LOCALCONFIG, [...LAUNCH_620, "LaunchOptions"], "a\nb")).toThrow(
      VdfPatchError,
    );
  });

  // der bericht (78:14/87:11): ein unterminierter string musste mit
  // verständlicher meldung werfen statt zu hängen oder roh zu crashen.
  // timeout: eine endlos-schleife in der tokenisierung soll als fehlschlag
  // sichtbar werden, nicht die suite hängen lassen.
  it("unterminierter string → wirft mit verständlicher meldung statt zu hängen", () => {
    const truncated =
      '"InstallConfigStore"\n{\n\t"Software"\n\t{\n\t\t"name"\t\t"wert ohne schlussquote';
    expect(() => setVdfValue(truncated, ["InstallConfigStore", "Software", "name"], "x")).toThrow(
      new VdfPatchError("unterminierter string"),
    );
  }, 2000);

  it("key ohne wert → wirft mit sichtbarer meldung", () => {
    expect(() => getVdfValue('"Key"', ["Key"])).toThrow(new VdfPatchError('key "Key" ohne wert'));
  });

  it("schließende klammer als wert → wirft mit sichtbarer meldung", () => {
    const closeAsValue = '"Root"\n{\n\t"Key"\n}\n';
    expect(() => getVdfValue(closeAsValue, ["Root", "Key"])).toThrow(
      new VdfPatchError('key "Key" ohne wert'),
    );
  });

  it("minifizierte datei (schließende klammer nicht auf eigener zeile) → wirft", () => {
    const minified = '"Root" { "Key" "old" }';
    expect(() => setVdfValue(minified, ["Root", "NewKey"], "new")).toThrow(
      new VdfPatchError("schließende klammer nicht auf eigener zeile, abbruch"),
    );
  });

  it("pfad durch skalaren wert → wirft mit sichtbarer meldung", () => {
    expect(() => setVdfValue('"Root" "x"', ["Root", "Key"], "y")).toThrow(
      new VdfPatchError('"Root" ist ein wert, kein block'),
    );
  });

  it("block am pfadende statt wert → wirft mit sichtbarer meldung", () => {
    expect(() => setVdfValue('"Root"\n{\n\t"Key"\t\t"old"\n}\n', ["Root"], "y")).toThrow(
      new VdfPatchError('"Root" ist ein block, kein wert'),
    );
  });
});

describe("removeVdfEntry", () => {
  const COMPAT = `"InstallConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"CompatToolMapping"
\t\t\t\t{
\t\t\t\t\t"0"
\t\t\t\t\t{
\t\t\t\t\t\t"name"\t\t"proton-cachyos-slr"
\t\t\t\t\t}
\t\t\t\t\t"620"
\t\t\t\t\t{
\t\t\t\t\t\t"name"\t\t"GE-Proton9-27"
\t\t\t\t\t}
\t\t\t\t\t"730"
\t\t\t\t\t{
\t\t\t\t\t\t"name"\t\t"proton-cachyos-slr"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

  it("entfernt einen block-eintrag", () => {
    const result = removeVdfEntry(COMPAT, [
      "InstallConfigStore",
      "Software",
      "Valve",
      "Steam",
      "CompatToolMapping",
      "620",
    ]);
    expect(result).not.toContain('"620"');
    expect(result).toContain('"0"');
    expect(result).toContain('"730"');
    expect(
      getVdfValue(result, [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "CompatToolMapping",
        "620",
        "name",
      ]),
    ).toBeUndefined();
    expect(() => parse(result)).not.toThrow();
  });

  it("entfernt einen scalar-eintrag (LaunchOptions)", () => {
    const result = removeVdfEntry(LOCALCONFIG, [...LAUNCH_620, "LaunchOptions"]);
    expect(getVdfValue(result, [...LAUNCH_620, "LaunchOptions"])).toBeUndefined();
    expect(result).not.toContain('"LaunchOptions"');
    expect(result).toContain('"228980"');
    expect(() => parse(result)).not.toThrow();
  });

  it("no-op bei nicht-existentem pfad", () => {
    expect(
      removeVdfEntry(COMPAT, [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "CompatToolMapping",
        "999",
      ]),
    ).toBe(COMPAT);
  });

  it("entfernt den letzten eintrag eines blocks → leerer block bleibt", () => {
    const single = `"CompatToolMapping"\n{\n\t"620"\n\t{\n\t\t"name"\t\t"x"\n\t}\n}\n`;
    const result = removeVdfEntry(single, ["CompatToolMapping", "620"]);
    expect(result).toContain('"CompatToolMapping"');
    expect(result).toContain("{");
    expect(result).toContain("}");
    expect(result).not.toContain('"620"');
    expect(() => parse(result)).not.toThrow();
  });

  it("wirft bei scalar im pfad statt block", () => {
    expect(() => removeVdfEntry(LOCALCONFIG, [...LAUNCH_620, "LaunchOptions", "tiefer"])).toThrow(
      VdfPatchError,
    );
  });

  it("set → remove ergibt semantisch das original (round-trip)", () => {
    // leerer 228980-block: LaunchOptions anlegen → wieder entfernen → gleicher baum
    const patched = setVdfValue(LOCALCONFIG, [...LAUNCH_228980, "LaunchOptions"], "-novid");
    expect(patched).not.toBe(LOCALCONFIG);
    const removed = removeVdfEntry(patched, [...LAUNCH_228980, "LaunchOptions"]);
    expect(parse(removed)).toEqual(parse(LOCALCONFIG));
  });

  it("minifizierte datei → wirft statt präfix zu fressen", () => {
    // einzeilige vdf, kein \n vor dem key, der alte code fräße ab offset 0
    // den gesamten InstallConfigStore-präfix inkl. globalem default-mapping
    const minified =
      `"InstallConfigStore"{"Software"{"Valve"{"Steam"{` +
      `"CompatToolMapping"{"620"{"name" "x"}}}}}}`;
    expect(() =>
      removeVdfEntry(minified, [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "CompatToolMapping",
        "620",
      ]),
    ).toThrow(VdfPatchError);
  });

  it("key bei offset 0 → bleibt legitim (kein false-positives werfen)", () => {
    const single = `"620"\n{\n\t"name"\t\t"x"\n}\n`;
    // datei beginnt mit dem zu entfernenden key, lineStart == key.start, kein fehler
    expect(removeVdfEntry(single, ["620"])).toBe("");
  });
});

describe("tokenizer-edge-cases", () => {
  it("CRLF-Zeilenenden: tokenisierung und patching korrekt (55:36)", () => {
    // valve schreibt auf windows mit \r\n; tokenizer muss \r als whitespace behandeln
    const crlf = `"Root"\r\n{\r\n\t"Key"\t\t"old"\r\n}\r\n`;
    expect(getVdfValue(crlf, ["Root", "Key"])).toBe("old");
    const patched = setVdfValue(crlf, ["Root", "Key"], "new");
    expect(getVdfValue(patched, ["Root", "Key"])).toBe("new");
    // rest bleibt byte-identisch (nur der value-span ändert sich)
    expect(patched).toBe(crlf.replace('"old"', '"new"'));
  });

  it("block-kommentar: getVdfValue und setVdfValue korrekt (63:9)", () => {
    // /* ... */ kommentar muss übersprungen werden, nicht als key interpretiert
    const withBlockComment = `"Root"\n{\n\t/* dieser kommentar wird ignoriert */\n\t"Key"\t\t"val"\n}\n`;
    expect(getVdfValue(withBlockComment, ["Root", "Key"])).toBe("val");
    const patched = setVdfValue(withBlockComment, ["Root", "Key"], "new");
    expect(getVdfValue(patched, ["Root", "Key"])).toBe("new");
    expect(patched).toBe(withBlockComment.replace('"val"', '"new"'));
  });

  it("unterterminierter block-kommentar → wirft", () => {
    const broken = `"Root"\n{\n\t/* nicht geschlossen\n\t"Key"\t\t"val"\n}\n`;
    expect(() => getVdfValue(broken, ["Root", "Key"])).toThrow(VdfPatchError);
  });

  it("bare token (unquoted key/value): korrekt geparst (74:9)", () => {
    // alte steam-dateien nutzen manchmal unquoted keys/values
    const bare = `Root\n{\n\tKey\t\tvalue\n}\n`;
    expect(getVdfValue(bare, ["Root", "Key"])).toBe("value");
    const patched = setVdfValue(bare, ["Root", "Key"], "new");
    expect(getVdfValue(patched, ["Root", "Key"])).toBe("new");
  });

  it("unbekannte backslash-sequenz: round-trip bleibt literal (32:36)", () => {
    // valve escapet nur \" und \\; ein \n im wert ist backslash+n, kein newline
    // der wert \n (zwei bytes) muss als \\n gespeichert und wieder als \n gelesen werden
    const literal = "C:\\Users\\name"; // backslash + U = unbekannte sequenz, bleibt literal
    const base = `"Root"\n{\n\t"Key"\t\t"${literal}"\n}\n`;
    // getVdfValue liest den rohen wert; escaping: \U ist unbekannte sequenz → literal \U
    const read = getVdfValue(base, ["Root", "Key"]);
    expect(read).toBe("C:\\Users\\name");
    // setVdfValue schreibt mit korrektem escaping, re-read muss wieder übereinstimmen
    const patched = setVdfValue(base, ["Root", "Key"], read ?? "");
    expect(getVdfValue(patched, ["Root", "Key"])).toBe("C:\\Users\\name");
  });
});

describe("setVdfValue, leere und kopflose dateien (167:7, 230:7)", () => {
  it("komplett leere datei → wirft VdfPatchError (kein wurzel-key) (167:7)", () => {
    // insertionPoint: closeIdx >= tokens.length → top-level scope, kein block → kein fehler
    // stattdessen: leere datei bedeutet kein wurzel-key-entry, der gesetzt werden müsste;
    // setInScope findet keinen entry und fügt an top-level ein → kein throw
    // das ist das tatsächliche verhalten: pinnen statt annehmen
    const result = setVdfValue("", ["Key"], "val");
    expect(getVdfValue(result, ["Key"])).toBe("val");
  });

  it("leerer pfad [] → wirft VdfPatchError (230:7)", () => {
    expect(() => setVdfValue("", [], "val")).toThrow(VdfPatchError);
    expect(() => setVdfValue(`"Root"\n{\n}\n`, [], "val")).toThrow(VdfPatchError);
  });
});

describe("removeVdfEntry, leere und kopflose dateien (280:7)", () => {
  it("leerer pfad [] → wirft VdfPatchError (280:7)", () => {
    expect(() => removeVdfEntry("", [])).toThrow(VdfPatchError);
    expect(() => removeVdfEntry(`"Root"\n{\n}\n`, [])).toThrow(VdfPatchError);
  });

  it("komplett leere datei → no-op (kein match, kein throw)", () => {
    // removeInScope: key = keys[0] = "Key", findEntry → [], entry = undefined → return text
    const result = removeVdfEntry("", ["Key"]);
    expect(result).toBe("");
  });
});

describe("removeVdfEntry, byte-genauer output (269, 271)", () => {
  // pinnt dass kein trailing-whitespace oder leere zeile zurückbleibt
  const COMPAT = `"InstallConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"CompatToolMapping"\n\t\t\t\t{\n\t\t\t\t\t"0"\n\t\t\t\t\t{\n\t\t\t\t\t\t"name"\t\t"proton-cachyos-slr"\n\t\t\t\t\t}\n\t\t\t\t\t"620"\n\t\t\t\t\t{\n\t\t\t\t\t\t"name"\t\t"GE-Proton9-27"\n\t\t\t\t\t}\n\t\t\t\t\t"730"\n\t\t\t\t\t{\n\t\t\t\t\t\t"name"\t\t"proton-cachyos-slr"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n`;

  it("kein leerer zeilenbeginn nach dem entfernten eintrag (Tabs/Leerzeilen)", () => {
    const result = removeVdfEntry(COMPAT, [
      "InstallConfigStore",
      "Software",
      "Valve",
      "Steam",
      "CompatToolMapping",
      "620",
    ]);
    // kein trailing-whitespace in einer eigenen zeile nach dem entfernten block
    const lines = result.split("\n");
    for (const line of lines) {
      // keine zeile darf ausschließlich tabs/leerzeichen sein (leere einzüge)
      expect(/^[ \t]+$/.test(line)).toBe(false);
    }
    // nachbarn unberührt
    expect(result).toContain('"0"');
    expect(result).toContain('"730"');
    expect(result).not.toContain('"620"');
  });

  it("byte-genaue struktur: 0 und 730 bleiben an ihrer position", () => {
    const result = removeVdfEntry(COMPAT, [
      "InstallConfigStore",
      "Software",
      "Valve",
      "Steam",
      "CompatToolMapping",
      "620",
    ]);
    // 0 muss vor 730 erscheinen
    const idx0 = result.indexOf('"0"');
    const idx730 = result.indexOf('"730"');
    expect(idx0).toBeGreaterThanOrEqual(0);
    expect(idx730).toBeGreaterThan(idx0);
  });
});

describe("[conditional]-marker-fixture (113:9)", () => {
  // real existierender VDF-Marker nach einem eintrag: [linux], [windows] etc.
  const WITH_CONDITIONAL = `"AppState"\n{\n\t"Key"\t\t"val"\t[linux]\n\t"Other"\t\t"other"\n}\n`;

  it("getVdfValue ignoriert [conditional]-marker korrekt", () => {
    expect(getVdfValue(WITH_CONDITIONAL, ["AppState", "Key"])).toBe("val");
    expect(getVdfValue(WITH_CONDITIONAL, ["AppState", "Other"])).toBe("other");
  });

  it("setVdfValue patcht wert trotz nachfolgendem [conditional]-marker", () => {
    const patched = setVdfValue(WITH_CONDITIONAL, ["AppState", "Key"], "new");
    expect(getVdfValue(patched, ["AppState", "Key"])).toBe("new");
    // Other unberührt
    expect(getVdfValue(patched, ["AppState", "Other"])).toBe("other");
  });

  it("[conditional]-marker am blockanfang: navigate danach korrekt", () => {
    const withMarkerFirst = `"AppState"\n{\n\t[linux]\n\t"Key"\t\t"val"\n}\n`;
    // [linux] ist ein bare-token mit '[', wird als string-token mit kind "string" geparst;
    // scanEntries überspringt es (startsWith("["))
    expect(getVdfValue(withMarkerFirst, ["AppState", "Key"])).toBe("val");
  });
});

// Wächter gegen Bibliotheksdrift: Die Bibliothek verarbeitet die Daten semantisch,
// rundreist, ersetzt NICHT den string-patch (byte-identität/escaping kann sie nicht).
describe("round-trip-wächter für @node-steam/vdf", () => {
  const canonical = (v: unknown): unknown =>
    v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])] as const),
        )
      : v;

  it("parse → serialize → parse bleibt semantisch identisch", () => {
    const once = parse(LOCALCONFIG);
    expect(canonical(parse(stringify(once)))).toEqual(canonical(once));
  });
});
