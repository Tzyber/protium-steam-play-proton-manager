import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCompatToolMapping, readToolVdf } from "../../src/core/compatTools.js";
import { MAX_APP_ID } from "../../src/core/guards.js";

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

// F5.4: Steam legt die zuordnung in zwei layouts ab. Der lesepfad liest beide
// und ist first-wins; der löschpfad (delete_usage.rs:404-413) vereinigt beide
// layouts und kann deshalb mehr apps nennen.
describe("parseCompatToolMapping liest beide mapping-layouts", () => {
  const klassisch = (inner: string): string => `"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"CompatToolMapping"
				{
${inner}
				}
			}
		}
	}
}`;

  const flach = (inner: string): string => `"Software"
{
	"Valve"
	{
		"Steam"
		{
			"CompatToolMapping"
			{
${inner}
			}
		}
	}
}`;

  it("liest das flache Software-layout", () => {
    const cfg = flach(`					"730"
					{
						"name"		"proton_experimental"
					}`);
    const map = parseCompatToolMapping(cfg);
    expect(map.get(730)).toBe("proton_experimental");
    expect(map.size).toBe(1);
  });

  it("liest beide layouts aus einem dokument", () => {
    const cfg = `${klassisch(`					"620"
					{
						"name"		"GE-Proton9-27"
					}`)}
${flach(`					"730"
					{
						"name"		"proton_experimental"
					}`)}`;
    const map = parseCompatToolMapping(cfg);
    expect(map.get(620)).toBe("GE-Proton9-27");
    expect(map.get(730)).toBe("proton_experimental");
    expect(map.size).toBe(2);
  });

  it("erste zuordnung je AppID gewinnt bei doppelten einträgen", () => {
    const cfg = `${klassisch(`					"620"
					{
						"name"		"GE-Proton9-27"
					}`)}
${flach(`					"620"
					{
						"name"		"proton_experimental"
					}
					"730"
					{
						"name"		"proton-cachyos-slr"
					}`)}`;
    const map = parseCompatToolMapping(cfg);
    expect(map.get(620)).toBe("GE-Proton9-27");
    // der nicht-konflikt-eintrag des zweiten layouts bleibt sichtbar
    expect(map.get(730)).toBe("proton-cachyos-slr");
    expect(map.size).toBe(2);
  });

  it('behält "0" aus dem ersten layout als globalen default', () => {
    const cfg = `${klassisch(`					"0"
					{
						"name"		"proton-cachyos-slr"
					}`)}
${flach(`					"0"
					{
						"name"		"proton_experimental"
					}`)}`;
    const map = parseCompatToolMapping(cfg);
    expect(map.get(0)).toBe("proton-cachyos-slr");
    expect(map.size).toBe(1);
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

  it("wirft bei mehr als einem eintrag unter compat_tools", () => {
    expect(() =>
      readToolVdf(
        `"compatibilitytools"\n{\n\t"compat_tools"\n\t{\n\t\t"a"\n\t\t{\n\t\t}\n\t\t"b"\n\t\t{\n\t\t}\n\t}\n}`,
        "fallback",
      ),
    ).toThrow("compat_tools must contain exactly one tool");
  });
});

// vertragstest S-03: die datei ist der byte-genaue output von
// extract_vdf_block für das klassische layout
// (src-tauri/src/commands/vdf_patch_tests.rs,
// cross_parser_mapping_ist_echter_rust_output). So kommt config.vdf im
// frontend an: nur das mapping, ohne login-tokens. Seit F5.4 liefert der
// produktive pfad (reduce_compat_config) zusätzlich das flache layout; die
// mehrfach-wurzel-form ist im block "beide mapping-layouts" oben gepinnt.
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

// Cross-parser-vertrag für beide layouts: die datei ist der byte-genaue output
// von reduce_compat_config für einen text mit klassischem UND flachem layout
// (src-tauri/src/commands/fs_ops_tests.rs,
// reduce_compat_config_beide_layouts_ist_byte_gleich_der_fixture).
describe("parseCompatToolMapping liest das reduzierte config.vdf mit beiden layouts", () => {
  const RUST_OUTPUT = readFileSync(
    resolve(import.meta.dirname, "../fixtures/cross-parser-mapping-both-layouts.vdf"),
    "utf8",
  );

  it("sieht die AppIDs aus beiden layouts", () => {
    const mapping = parseCompatToolMapping(RUST_OUTPUT);
    expect(mapping.get(620)).toBe("GE-Proton9-1");
    expect(mapping.get(730)).toBe("proton_experimental");
    expect(mapping.size).toBe(2);
  });

  it("enthält keine login-daten", () => {
    for (const secret of ["ConnectCache", "geheim", "Accounts", "SentryFile"]) {
      expect(RUST_OUTPUT).not.toContain(secret);
    }
  });
});

// Gegenprobe zum selben vertrag: liegt nur das klassische layout vor, besteht
// das reduzierte dokument aus dem klassischen block plus dem leeren gerüst des
// flachen layouts als zweitem root-knoten. Die gerüst-form ist in
// reduce_compat_config_klassisch_ohne_flach_haelt_leeres_geruest gepinnt.
describe("parseCompatToolMapping liest das reduzierte config.vdf ohne flaches layout", () => {
  const KLASSISCH_ONLY = readFileSync(
    resolve(import.meta.dirname, "../fixtures/cross-parser-mapping-expected.vdf"),
    "utf8",
  );
  const LEERES_GERUEST = '"Software"\n{\n"Valve"\n{\n"Steam"\n{\n\n}\n}\n}';

  it("liefert nur die klassischen AppIDs", () => {
    const mapping = parseCompatToolMapping(`${KLASSISCH_ONLY}\n${LEERES_GERUEST}`);
    expect(mapping.get(0)).toBe("proton_experimental");
    expect(mapping.get(620)).toBe("GE-Proton9-1");
    expect(mapping.size).toBe(2);
  });
});
