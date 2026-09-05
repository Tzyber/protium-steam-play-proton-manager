import { readFileSync } from "node:fs";
import { parse } from "@node-steam/vdf";
import { describe, expect, it } from "vitest";
import { asNode, getPath, parseVdf, type VdfNode, type VdfValue } from "../../src/core/vdf";
import { getVdfValue } from "../../src/core/vdfpatch.js";

describe("parseVdf prototype-safety", () => {
  it("neutralisiert __proto__-keys: keine globale prototype-pollution", () => {
    const text = `"root"
{
\t"__proto__"
\t{
\t\t"polluted"\t\t"yes"
\t}
\t"normal"\t\t"value"
}`;
    const parsed = parseVdf(text);
    // object.prototype darf nicht verschmutzt sein (die lib würde sonst
    // global Object.prototype.polluted setzen)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // normale keys bleiben erreichbar; "__proto__" liegt nicht als
    // prototype-kette im ergebnis
    expect(getPath(parsed, "root", "normal")).toBe("value");
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it("neutralisiert kommentierte gefährliche block-keys auf root und in verschachtelten blöcken", () => {
    for (const key of ["__proto__", "constructor", "prototype"] as const) {
      const rootMarker = `root_polluted_${key}`;
      const nestedMarker = `nested_polluted_${key}`;
      const parsed = parseVdf(`"safe" "value"
"${key}" // root-kommentar
{
  "${rootMarker}" "yes"
}
"container"
{
  "safe" "value"
  "${key}" // verschachtelter kommentar
  {
    "${nestedMarker}" "yes"
  }
  "sibling" "readable"
}
"normal" "value"`);

      const objectPrototype = Object.prototype as Record<string, unknown>;
      const objectConstructor = Object as unknown as Record<string, unknown>;
      expect(objectPrototype[rootMarker]).toBeUndefined();
      expect(objectPrototype[nestedMarker]).toBeUndefined();
      expect(objectConstructor[rootMarker]).toBeUndefined();
      expect(objectConstructor[nestedMarker]).toBeUndefined();
      expect(getPath(parsed, "container", "sibling")).toBe("readable");
      expect(getPath(parsed, "normal")).toBe("value");
    }
  });

  it("liest harmlose kommentierte VDF-keys weiter", () => {
    const parsed = parseVdf(`"root" // block-kommentar
{
  /* normaler block-kommentar */
  "value" "text" // wert-kommentar
  "nested" // verschachtelter block-kommentar
  {
    "answer" "42"
  }
}`);

    expect(getPath(parsed, "root", "value")).toBe("text");
    expect(getPath(parsed, "root", "nested", "answer")).toBe(42);
  });

  it("lässt gefährliche wörter als VDF-werte unverändert", () => {
    const parsed = parseVdf(`"root"
{
  "proto" "__proto__"
  "ctor" "constructor"
  "prototype" "prototype"
}`);

    expect(getPath(parsed, "root", "proto")).toBe("__proto__");
    expect(getPath(parsed, "root", "ctor")).toBe("constructor");
    expect(getPath(parsed, "root", "prototype")).toBe("prototype");
  });

  it("lässt // in quoted werten und escaped quotes unverändert", () => {
    const value = 'text // \\"__proto__\\" \\"constructor\\"';
    const parsed = parseVdf(`"root"
{
  "value" "${value}"
}`);

    expect(getPath(parsed, "root", "value")).toBe(value);
  });

  it("verschachtelte nodes bleiben erreichbar", () => {
    const parsed = parseVdf(`"a"
{
\t"b"
\t{
\t\t"c"\t\t"1"
\t}
}`);
    expect(getPath(parsed, "a", "b", "c")).toBe(1);
  });
});

// vertragstest Rust -> @node-steam/vdf: die datei ist der byte-genaue output
// von set_vdf_value/remove_vdf_entry (erzeugt in
// src-tauri/src/commands/vdf_patch.rs, test
// cross_parser_erwartungsdatei_ist_echter_rust_output). schlägt hier etwas
// fehl, ist von Rust geschriebenes VDF für die lesende seite kaputt.
describe("cross-parser-vertrag Rust -> @node-steam/vdf", () => {
  const RUST_OUTPUT = readFileSync(
    `${process.cwd()}/tests/fixtures/cross-parser-expected.vdf`,
    "utf8",
  );
  const APPS = ["UserLocalConfigStore", "Software", "Valve", "Steam", "Apps"];

  it("parst den rust-output ohne strukturverlust", () => {
    const parsed = parseVdf(RUST_OUTPUT);
    const apps = asNode(getPath(parsed, ...APPS));
    expect(apps).toBeDefined();
    expect(Object.keys(apps as VdfNode)).toEqual(["620", "730", "1091500"]);

    // neu angelegter block ist da
    expect(getPath(parsed, ...APPS, "1091500", "LaunchOptions")).toBeDefined();
    // entfernter scalar ist weg, sein geschwister im selben block bleibt
    expect(getPath(parsed, ...APPS, "620", "LastPlayed")).toBeUndefined();
    expect(getPath(parsed, ...APPS, "620", "LaunchOptions")).toBeDefined();
    // unbeteiligter nachbarblock unverändert
    expect(getPath(parsed, ...APPS, "730", "LaunchOptions")).toBe("-novid -high");
  });

  it("liefert werte mit quotes und backslashes escaped zurück", () => {
    // @node-steam/vdf entfernt die valve-escapes NICHT. deshalb liest die app
    // escaping-relevante werte über getVdfValue und nicht über parseVdf.
    const parsed = parseVdf(RUST_OUTPUT);
    expect(getPath(parsed, ...APPS, "620", "LaunchOptions")).toBe(
      'PROTON_LOG=1 MANGOHUD_CONFIG=\\"fps,gpu,ram\\" %command% --skip-launcher',
    );
    expect(getPath(parsed, ...APPS, "1091500", "LaunchOptions")).toBe(
      'WINEDLLOVERRIDES=\\"dinput8=n,b\\" PROTON_LOG_DIR=Z:\\\\home\\\\logs gamemoderun %command%',
    );
    // direkt gegen den rohen parser, den vdf.ts kapselt
    const raw = parse(RUST_OUTPUT) as Record<string, VdfValue>;
    expect(getPath(raw as VdfNode, ...APPS, "730", "LaunchOptions")).toBe("-novid -high");
  });

  it("gibt über getVdfValue exakt die von rust gesetzten werte zurück", () => {
    expect(getVdfValue(RUST_OUTPUT, [...APPS, "620", "LaunchOptions"])).toBe(
      'PROTON_LOG=1 MANGOHUD_CONFIG="fps,gpu,ram" %command% --skip-launcher',
    );
    expect(getVdfValue(RUST_OUTPUT, [...APPS, "1091500", "LaunchOptions"])).toBe(
      'WINEDLLOVERRIDES="dinput8=n,b" PROTON_LOG_DIR=Z:\\home\\logs gamemoderun %command%',
    );
    expect(getVdfValue(RUST_OUTPUT, [...APPS, "620", "LastPlayed"])).toBeUndefined();
    expect(getVdfValue(RUST_OUTPUT, [...APPS, "730", "LaunchOptions"])).toBe("-novid -high");
  });
});
