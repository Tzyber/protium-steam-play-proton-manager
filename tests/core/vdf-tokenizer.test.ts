import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/core/manifest.js";
import { getPath, parseVdf } from "../../src/core/vdf.js";
import { getVdfValue, tokenizeVdf } from "../../src/core/vdfpatch.js";

// K-02: vdfpatch, manifest und vdf teilen sich einen tokenizer. diese tests
// belegen die token-grenzen für die zuvor drift-anfälligen randfälle und dass
// die drei fassaden dieselbe eingabe über dieselben grenzen lesen.
const kinds = (text: string): string[] => tokenizeVdf(text).tokens.map((token) => token.kind);
const spans = (text: string): string[] =>
  tokenizeVdf(text).tokens.map((token) => text.slice(token.start, token.end));

describe("gemeinsamer Text-VDF-Tokenizer (K-02)", () => {
  it("überspringt einen //-kommentar am dateiende ohne neue zeile", () => {
    const text = '"a" "b" // rest ohne newline';
    expect(spans(text)).toEqual(['"a"', '"b"']);
    expect(tokenizeVdf(text).unterminated).toBeUndefined();
  });

  it("meldet ein /* ohne abschluss und lässt den rest aus den tokens", () => {
    const text = '"a" "b" /* offen\n"c" "d"';
    expect(spans(text)).toEqual(['"a"', '"b"']);
    expect(tokenizeVdf(text).unterminated).toBe("block-comment");
  });

  it("meldet einen offenen string", () => {
    const text = '"a" "b';
    expect(spans(text)).toEqual(['"a"']);
    expect(tokenizeVdf(text).unterminated).toBe("string");
  });

  it("lässt einen backslash vor einem nicht-escape-zeichen literal", () => {
    const text = String.raw`"a" "b\q"`;
    const tokens = tokenizeVdf(text).tokens;
    expect(tokens.map((token) => token.raw)).toEqual(["a", String.raw`b\q`]);
    expect(tokens.map((token) => token.value)).toEqual(["a", String.raw`b\q`]);
    expect(tokenizeVdf(text).unterminated).toBeUndefined();
  });

  it("entschärft nur escapte quotes und backslashes", () => {
    const token = tokenizeVdf(String.raw`"a\q\"b\\c"`).tokens[0];
    expect(token?.raw).toBe(String.raw`a\q\"b\\c`);
    expect(token?.value).toBe(String.raw`a\q"b\c`);
  });

  it("behandelt ein mehrbyte-zeichen nach backslash", () => {
    const text = String.raw`"a" "b\ä"`;
    expect(tokenizeVdf(text).unterminated).toBeUndefined();
    expect(tokenizeVdf(text).tokens.map((token) => token.raw)).toEqual(["a", String.raw`b\ä`]);
  });

  it("fasst ein conditional mit leerzeichen zu einem token", () => {
    const text = "a [b c] d";
    expect(kinds(text)).toEqual(["string", "conditional", "string"]);
    expect(spans(text)).toEqual(["a", "[b c]", "d"]);
  });

  it("erkennt ein bare-token mit `[` am anfang als conditional-marker", () => {
    const text = '"k" [linux] "v"';
    expect(kinds(text)).toEqual(["string", "conditional", "string"]);
    expect(spans(text)).toEqual(['"k"', "[linux]", '"v"']);
  });

  it("bricht ein bare-token am kommentaranfang ab", () => {
    expect(spans("a//rest")).toEqual(["a"]);
  });

  it("liest einen bare-token mit `[` nicht als eigenständigen key in vdfpatch", () => {
    // der conditional-marker darf die key-/value-paare nicht verschieben.
    const text = '"Root"\n{\n\t"Key"\t\t"value"\t[linux]\n\t"Other"\t\t"other"\n}\n';
    expect(getVdfValue(text, ["Root", "Key"])).toBe("value");
    expect(getVdfValue(text, ["Root", "Other"])).toBe("other");
  });
});

describe("die drei leser teilen die token-grenzen (K-02)", () => {
  const TEXT = String.raw`"AppState"
{
	"appid"		"620"
	"name"		"Portal 2"
	"SizeOnDisk"		"123456"
	"installdir"		"Portal 2"
	"LaunchOptions"		"MANGOHUD_CONFIG=\"fps\" C:\\logs"		// trailing
}
`;

  it("vdfpatch liefert den unescapten wert", () => {
    expect(getVdfValue(TEXT, ["AppState", "LaunchOptions"])).toBe(
      String.raw`MANGOHUD_CONFIG="fps" C:\logs`,
    );
  });

  it("vdf erhält die rohform (die lib unescaped nicht)", () => {
    expect(getPath(parseVdf(TEXT), "AppState", "LaunchOptions")).toBe(
      String.raw`MANGOHUD_CONFIG=\"fps\" C:\\logs`,
    );
  });

  it("manifest liest die rohfelder", () => {
    expect(parseManifest(TEXT)).toEqual({
      appId: 620,
      name: "Portal 2",
      sizeBytes: 123456,
      installdir: "Portal 2",
    });
  });

  it("erzeugt trotz trailing-kommentar und escapes dieselben grenzen ohne drift", () => {
    expect(spans(TEXT)).toContain(String.raw`"MANGOHUD_CONFIG=\"fps\" C:\\logs"`);
    // der trailing-kommentar erzeugt keinen token und keine kippende marke.
    expect(kinds(TEXT)).not.toContain("conditional");
    expect(tokenizeVdf(TEXT).unterminated).toBeUndefined();
  });

  it("behält ein mehrbyte-zeichen nach backslash in vdfpatch", () => {
    const text = String.raw`"Root"
{
	"Key"		"a\äb"
}
`;
    expect(getVdfValue(text, ["Root", "Key"])).toBe(String.raw`a\äb`);
  });

  // auflagen aus dem review zu K-02: die beiden verhaltensänderungen, die die
  // vereinheitlichung in den lesepfad bringt, werden an echten eingaben
  // festgehalten statt nur am tokenizer.
  it("liest einen bare-wert, der an einem kommentar endet, als wert", () => {
    // die vorfassung von vdfpatch brach ein bare-token nicht am kommentaranfang
    // ab; jetzt endet es dort (wie in manifest und vdf und in der lib). ein
    // bare `//` ist damit ein kommentaranfang, kein wertbestandteil.
    const text = '"AppState"\n{\n\t"appid"\t\t620// rest ohne newline\n\t"name"\t\t"Portal"\n}\n';
    expect(getVdfValue(text, ["AppState", "appid"])).toBe("620");
    expect(getVdfValue(text, ["AppState", "name"])).toBe("Portal");
  });

  it("überspringt einen mehrteiligen conditional-marker durch den ganzen leser", () => {
    // `[$WIN32 || $OSX64]` ist ein token; die vorfassung zerlegte es in drei
    // bare-tokens und verschob damit die key/value-paare. der marker hängt am
    // vorigen wert und darf die folgenden paare nicht verschieben.
    const text =
      '"UserLocalConfigStore"\n{\n\t"Key"\t\t"value" [$WIN32 || $OSX64]\n\t"Other"\t\t"other"\n}\n';
    expect(getVdfValue(text, ["UserLocalConfigStore", "Key"])).toBe("value");
    expect(getVdfValue(text, ["UserLocalConfigStore", "Other"])).toBe("other");
  });

  it("behandelt einen quotierten schlüssel mit führendem [ als key", () => {
    // alt übersprang scanEntries jedes string-token, dessen wert mit "[" begann
    // — auch ein quotiertes. neu wird nur der marker-kind übersprungen, ein
    // quotierter key bleibt damit ein key.
    const text = '"root"\n{\n\t"[x]"\t\t"v"\n}\n';
    expect(getVdfValue(text, ["root", "[x]"])).toBe("v");
  });
});
