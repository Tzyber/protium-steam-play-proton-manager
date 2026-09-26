import { describe, expect, it, vi } from "vitest";
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

  it("trennt an jedem zeichen, das trim als leer erkennt", () => {
    // valve-whitespace ist mehr als ` \t\r\n`: die geparste lib trennt mit
    // `trim`, deshalb spaltet u+00a0 auch bare-tokens (isVdfWhitespace,
    // vdfpatch.ts). die vorfassung von vdfpatch ließ `a\u00a0b` verkleben.
    expect(spans("a\u00a0b")).toEqual(["a", "b"]);
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

  it("bricht einen bare-wert am blockkommentar ab, ohne die datei zu verwerfen", () => {
    // analog zu `http://x` → `http:` endet der wert am kommentaranfang, der
    // tote rest reicht nur bis zeilenende, auch ohne `*/`. vorher warf vdfpatch
    // "unterminierter block-kommentar" und erklärte eine lesbare datei für
    // lexikalisch defekt (N-5).
    const text = '"Root"\n{\n\tKey\t\ta/*b\n}\n';
    expect(getVdfValue(text, ["Root", "Key"])).toBe("a");
    expect(tokenizeVdf(text).unterminated).toBeUndefined();
  });

  it("lässt einen conditional-marker zwischen key und wert bei der paarung aus (N-01)", () => {
    // degeneriert: steam schreibt marker nach dem wert. der marker zählt nie
    // als wert, also paart `key [cond]` `value` jetzt key→value wie der
    // manifest-leser (manifest.ts:29) statt den marker zu koppeln und über den
    // rest mit "key ohne wert" zu werfen. ohne echten wert bleibt der
    // strukturbruch bestehen wie bei `key` allein.
    const text = '"Root"\n{\n\t"Key" [$WIN32]\t\t"value"\n\t"Other"\t\t"other"\n}\n';
    expect(getVdfValue(text, ["Root", "Key"])).toBe("value");
    expect(getVdfValue(text, ["Root", "Other"])).toBe("other");
    expect(() => getVdfValue('"Root"\n{\n\t"Key" [$WIN32]\n}\n', ["Root", "Key"])).toThrow(
      'key "Key" ohne wert',
    );
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
    // alt übersprang scanEntries jedes string-token, dessen wert mit "[" begann,
    // auch ein quotiertes. neu wird nur der marker-kind übersprungen, ein
    // quotierter key bleibt damit ein key.
    const text = '"root"\n{\n\t"[x]"\t\t"v"\n}\n';
    expect(getVdfValue(text, ["root", "[x]"])).toBe("v");
  });
});

describe("skalierung des tokenizers (A-01)", () => {
  // Der bedingte zweig suchte das zeilenende per `indexOf` über den REST des
  // textes, und zwar einmal pro mark. Ohne zeilenumbruch kostete damit jeder
  // mark O(rest) ⇒ O(n²). Zwei belege, bewusst getrennt:
  //  1. deterministisch: die zahl der `indexOf`-aufrufe war 2 pro mark.
  //  2. verhältnis: die marken-eingabe wird gegen eine token-gleiche eingabe
  //     OHNE marken gemessen. Damit fallen maschinengeschwindigkeit und
  //     grundlast heraus; vor dem fix kostete die markenfolge ein vielfaches des
  //     bezugs, danach liegt sie in derselben größenordnung. absolute zeiten
  //     werden nicht geprüft.
  const SIZES = [20_000, 40_000, 80_000] as const;
  const RUNS_PER_SIZE = 3;
  const NORMALIZED_LIMIT = 6;
  /** Unter Stryker laufen die tests in instrumentiertem code (coverage) und in
   *  worker-prozessen: die wanduhr-messung ist dort weder aussagekräftig noch
   *  schnell genug (der dry run lief in den vitest-timeout von 5000 ms). Der
   *  deterministische `indexOf`-pin unten bleibt aktiv und tötet die mutanten
   *  des zweigs; nur die zeitmessung wird dort ausgesetzt. */
  const underMutation = process.env.STRYKER_MUTATOR_WORKER !== undefined;

  function bestOf(runs: number, run: () => void): number {
    let best = Number.POSITIVE_INFINITY;
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      run();
      best = Math.min(best, performance.now() - started);
    }
    return best;
  }

  const markers = (count: number): string => "[x]".repeat(count);
  /** gleich viele tokens derselben art (bare), nur ohne marken. */
  const reference = (count: number): string => "x ".repeat(count);
  const ms = (value: number): string => `${value.toFixed(2)}ms`;

  it("sucht das zeilenende nicht mehr einmal pro mark im resttext", () => {
    const indexOf = vi.spyOn(String.prototype, "indexOf");
    try {
      const before = indexOf.mock.calls.length;
      const { tokens } = tokenizeVdf(markers(SIZES[2]));
      const calls = indexOf.mock.calls.length - before;
      expect(tokens).toHaveLength(SIZES[2]);
      // vor dem fix: 2 aufrufe je mark (160000). nach dem fix: keiner, die
      // grenze kommt aus einem vorwärtsscan. Die schwelle lässt raum für
      // fremde aufrufe (instrumentation), liegt aber weit unter dem fehlerbild.
      expect(calls).toBeLessThan(SIZES[2] / 10);
    } finally {
      indexOf.mockRestore();
    }
  });

  it.skipIf(underMutation)(
    "kostet bei vielen marken höchstens das N-fache des markenfreien bezugs",
    () => {
      // die tokenzahl beider eingaben ist gleich; sonst verglichen wir ungleiche
      // arbeit und der test behauptete etwas, das er nicht prüft.
      for (const size of SIZES) {
        expect(tokenizeVdf(markers(size)).tokens).toHaveLength(size);
        expect(tokenizeVdf(reference(size)).tokens).toHaveLength(size);
      }
      const measured = SIZES.map((size) => bestOf(RUNS_PER_SIZE, () => tokenizeVdf(markers(size))));
      const baseline = SIZES.map((size) =>
        bestOf(RUNS_PER_SIZE, () => tokenizeVdf(reference(size))),
      );
      const factors = measured.map((value, index) => value / Math.max(baseline[index] ?? 0, 0.01));
      expect(
        Math.max(...factors),
        `verhaeltnis je groesse ${factors.map((value) => value.toFixed(2)).join("/")}; ` +
          `marken ${measured.map(ms).join("/")}; bezug ${baseline.map(ms).join("/")}`,
      ).toBeLessThan(NORMALIZED_LIMIT);
    },
  );

  it("trennt zwei marken ohne zeilenumbruch", () => {
    expect(kinds("[a][b]\n")).toEqual(["conditional", "conditional"]);
    expect(spans("[a][b]\n")).toEqual(["[a]", "[b]"]);
  });

  it("beendet ein conditional am zeilenende, auch wenn danach ] folgt", () => {
    // Die grenze bleibt `]`-oder-zeilenende: ein `]` hinter dem umbruch gehört
    // nicht mehr zum marker, der rest wird zum bare-token.
    expect(spans("[a\nb]")).toEqual(["[a", "b]"]);
  });
});
