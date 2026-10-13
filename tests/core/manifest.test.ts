import { describe, expect, it } from "vitest";
import { parseSafeAppId } from "../../src/core/guards.js";
import { parseManifest } from "../../src/core/manifest.js";

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
