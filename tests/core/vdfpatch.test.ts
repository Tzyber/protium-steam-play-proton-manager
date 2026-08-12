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

// drift-wächter (PROTIUM_STATUS phase 4): dokumentiert, dass die lib semantisch
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
