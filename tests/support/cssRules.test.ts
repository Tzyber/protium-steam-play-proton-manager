// @vitest-environment node
import { describe, expect, it } from "vitest";
import { declarationValue, flattenCss, mediaRuleBlock, ruleBlock, ruleCount } from "./cssRules";
import { readRepoFile } from "./themeTokens";

/** FR-5: Charakterisierungs-Pin für den Regelparser. Ab dem Anlegen grün. */
describe("cssRules: Styleblock-Grenzen", () => {
  it("die erste Regel eines SFC-Styleblocks zählt genau einmal", () => {
    expect(ruleCount(readRepoFile("src/ui/components/ConfirmDialog.vue"), ".backdrop")).toBe(1);
    expect(ruleCount(readRepoFile("src/ui/components/FilterBar.vue"), ".filterbar")).toBe(1);
    expect(ruleCount(readRepoFile("src/ui/components/CleanupRow.vue"), ".row")).toBe(1);
    expect(ruleCount(readRepoFile("src/ui/components/SelectBox.vue"), ".sb")).toBe(1);
  });

  it("alle drei Schreibweisen des Fokus-Selektors zählen einmal", () => {
    const selectors = [
      ".btn:focus-visible,\n.btn.ghost:focus-visible",
      ".btn:focus-visible,.btn.ghost:focus-visible",
      ".btn:focus-visible, .btn.ghost:focus-visible",
    ];
    const source = ".btn:focus-visible,\n.btn.ghost:focus-visible { outline: none; }";
    for (const selector of selectors) {
      expect(ruleCount(source, selector), selector).toBe(1);
    }
  });

  it("ein Kindkombinator ist keine Regelgrenze", () => {
    expect(ruleCount(".parent > .child { color: red; } .child { color: blue; }", ".child")).toBe(1);
  });

  it("ein Klassenpräfix ist keine eigene Regel", () => {
    expect(ruleCount(".btn.ghost { color: red; }", ".btn")).toBe(0);
    expect(ruleCount(".btn { color: red; }", ".btn")).toBe(1);
  });

  it("declarationValue nimmt die letzte Deklaration", () => {
    const block = ruleBlock(".a { border: 1px solid red; border: 2px solid blue; }", ".a");
    expect(declarationValue(block, "border")).toBe("2px solid blue");
    expect(declarationValue(block, "missing")).toBeUndefined();
  });

  it("ein fehlender Selektor wirft mit der Meldung", () => {
    expect(() => ruleBlock(".a { color: red; }", ".b")).toThrow("Regel nicht gefunden: .b");
    expect(ruleCount(".a { color: red; }", ".b")).toBe(0);
  });

  it("ein Selektor im Kommentar zählt nicht", () => {
    const source = "/* .a { } */ .b { color: red; }";
    expect(ruleCount(source, ".a")).toBe(0);
    expect(ruleBlock(source, ".b")).toContain("color: red");
  });

  it("zwei Styleblöcke werden beide gefunden", () => {
    const source = "<style>.a { color: red; }</style><style>.b { color: blue; }</style>";
    expect(ruleCount(source, ".a")).toBe(1);
    expect(ruleCount(source, ".b")).toBe(1);
  });

  it("Template-Braces erzeugen keinen Regelanfang", () => {
    const source =
      "<template><div>{{ value }}</div></template><style>.target { color: red; }</style>";
    expect(ruleCount(source, ".target")).toBe(1);
    expect(ruleCount(source, ".value")).toBe(0);
  });

  it("flattenCss ist idempotent", () => {
    const source = ".a,\n.b   {   color: red;  }\n\n.c { color: blue; }";
    const once = flattenCss(source);
    expect(flattenCss(once)).toBe(once);
    expect(once).toBe(".a, .b { color: red; } .c { color: blue; }");
  });

  it("mediaRuleBlock liest verschachtelte Regeln im passenden @media-Block", () => {
    const source = `
      .shell { grid-template-columns: var(--sidebar-w) 1fr; }
      @media (max-width: 1199px) {
        .shell { --sidebar-w: var(--sidebar-w-compact); }
        .other { color: red; }
      }
    `;
    expect(
      declarationValue(mediaRuleBlock(source, "(max-width: 1199px)", ".shell"), "--sidebar-w"),
    ).toBe("var(--sidebar-w-compact)");
    expect(declarationValue(mediaRuleBlock(source, "(max-width: 1199px)", ".other"), "color")).toBe(
      "red",
    );
    expect(() => mediaRuleBlock(source, "(max-width: 999px)", ".shell")).toThrow(
      "Media-Block nicht gefunden: (max-width: 999px)",
    );
  });
});
