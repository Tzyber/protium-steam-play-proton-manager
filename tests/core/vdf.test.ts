import { describe, expect, it } from "vitest";
import { getPath, parseVdf } from "../../src/core/vdf";

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
