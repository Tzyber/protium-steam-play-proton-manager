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
