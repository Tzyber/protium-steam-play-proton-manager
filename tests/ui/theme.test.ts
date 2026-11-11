// @vitest-environment node
import { describe, expect, it } from "vitest";
import { flattenCss, ruleBlock } from "../support/cssRules";
import { readRepoFile, tokenValue } from "../support/themeTokens";

/** die vier dateien, die den literalen Rot-Ton #ff9aa0 trugen (audit 4.15). */
const DANGER_LITERAL_FILES = [
  "src/ui/components/CleanupNotices.vue",
  "src/ui/components/TrashPanel.vue",
  "src/ui/components/OrphanPanel.vue",
  "src/ui/views/CleanupView.vue",
];

describe("Theme-Tokens: Danger-Palette (4.15)", () => {
  it("tokens.css definiert --danger, --danger-hover, --danger-fg und --on-signal", () => {
    for (const token of ["--danger", "--danger-hover", "--danger-fg", "--on-signal"]) {
      expect(tokenValue(token), `${token} fehlt in tokens.css`).toBeDefined();
    }
  });

  it("--tier-borked bleibt die Tier-Farbe", () => {
    expect(tokenValue("--tier-borked")).toBe("#e85a63");
  });

  it("die vier Danger-Dateien nutzen Tokens statt des literalen Rot-Tons", () => {
    for (const file of DANGER_LITERAL_FILES) {
      const source = readRepoFile(file);
      expect(source, `${file} enthält noch #ff9aa0`).not.toContain("#ff9aa0");
    }
  });

  it("die gemeinsame .blocked-Form trägt Text, deckenden Rand und Flächen-Mix", () => {
    // P17a/FR-1: die wortgleiche .blocked-form der drei Cleanup-Panels steht
    // jetzt einmal in tokens.css statt dreimal in den komponenten.
    // FR-3.3: der rand ist deckend (--error-border) statt eines danger-mixes.
    const block = ruleBlock(
      readRepoFile("src/ui/tokens.css"),
      ".blocked:not(.blocked-explanation)",
    );
    expect(block).toContain("color: var(--danger-fg)");
    expect(block).toContain("border: 1px solid var(--error-border)");
    expect(block).toContain("background: color-mix(in srgb, var(--danger) 12%, transparent)");
  });

  it("CleanupViews Danger-Aktion nutzt die Danger-Tokens", () => {
    const block = ruleBlock(readRepoFile("src/ui/views/CleanupView.vue"), ".action.danger");
    expect(block).toContain("color: var(--danger-fg)");
    expect(block).toContain("background: color-mix(in srgb, var(--danger) 18%, transparent)");
    expect(block).toContain("border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent)");
  });

  it("ConfirmDialog nutzt die Danger-Tokens statt eigener Literale", () => {
    const source = readRepoFile("src/ui/components/ConfirmDialog.vue");
    expect(source).not.toContain("#c03940");
    expect(source).not.toContain("#a93238");
    expect(source).toMatch(/border:[^;]*var\(--danger\)/);
    expect(source).toMatch(/background:\s*var\(--danger\)/);
    expect(source).toMatch(/:hover[^}]*var\(--danger-hover\)/);
    expect(ruleBlock(source, ".btn")).toContain("color: var(--on-danger)");
    expect(source).not.toContain("#fff");
  });
});

describe("Signal-Text nutzt --on-signal", () => {
  const SIGNAL_FILES = [
    "src/ui/App.vue",
    "src/ui/components/AppSidebar.vue",
    "src/ui/components/PlayButton.vue",
    "src/ui/components/UpdateNotice.vue",
    "src/ui/components/ReleaseRow.vue",
    "src/ui/views/LibraryView.vue",
    "src/ui/views/CleanupView.vue",
    "src/ui/components/CleanupNotices.vue",
  ];

  it("alle Signal-Textflächen nutzen das Token als color", () => {
    for (const file of SIGNAL_FILES) {
      const source = readRepoFile(file);
      expect(source, `${file} nutzt --on-signal nicht als color`).toMatch(
        /color:\s*var\(--on-signal\)/,
      );
      expect(source, `${file} nutzt einen Flächen-Token als Textfarbe`).not.toMatch(
        /color:\s*(?:var\(--bg-0\)|var\(--bg-1\)|#0a0b11)/,
      );
    }
  });

  it("die Signal-Checkbox nutzt --on-signal", () => {
    const source = readRepoFile("src/ui/components/CleanupRow.vue");
    expect(source).toMatch(/border:\s*solid var\(--on-signal\)/);
    expect(source).not.toContain("var(--bg-0)");
  });
});

describe("P1-Tokensatz", () => {
  it("--on-danger ist reines Weiß", () => {
    expect(tokenValue("--on-danger")).toBe("#ffffff");
  });

  it("jedes Token steht genau einmal in tokens.css", () => {
    const source = flattenCss(readRepoFile("src/ui/tokens.css"));
    const names = [...source.matchAll(/(--[a-z0-9-]+)\s*:/g)].flatMap((match) => match[1] ?? []);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    expect(names.length, "tokens.css deklariert keine Custom Property").toBeGreaterThan(0);
    expect(duplicates).toEqual([]);
  });
});

describe("P2a: Basisflächen und gemeinsame Control-Form", () => {
  it(".control steht mit allen acht Deklarationen in tokens.css", () => {
    const block = ruleBlock(readRepoFile("src/ui/tokens.css"), ".control");
    for (const declaration of [
      "background: var(--bg-2)",
      "border: 1px solid var(--line-control)",
      "min-width: 0",
      "color: var(--fg-0)",
      "border-radius: var(--r-sm)",
      "flex: 1",
      "padding: 11px 13px",
      "font-size: 0.8125rem",
    ]) {
      expect(block, declaration).toContain(`${declaration};`);
    }
  });

  it(".control:focus-visible hält den Kontrollrand auf --signal", () => {
    const block = ruleBlock(
      readRepoFile("src/ui/components/GameDetailDrawer.vue"),
      ".control:focus-visible",
    );
    expect(block).toContain("outline: 2px solid var(--signal)");
    expect(block).toContain("border-color: var(--signal)");
  });

  it("die Scrollbar nutzt Breite und Thumb-Tokens", () => {
    const tokens = readRepoFile("src/ui/tokens.css");
    const bar = ruleBlock(tokens, "::-webkit-scrollbar");
    expect(bar).toContain("width: var(--scrollbar-w)");
    expect(bar).toContain("height: var(--scrollbar-w)");
    expect(ruleBlock(tokens, "::-webkit-scrollbar-thumb")).toContain(
      "background: var(--line-control)",
    );
    expect(ruleBlock(tokens, "::-webkit-scrollbar-thumb:hover")).toContain(
      "background: var(--fg-2)",
    );
    expect(tokens).not.toContain("#2a3048");
  });
});

describe("P2b: Fokusring, Input-Ränder und Warnfarbe", () => {
  it("FilterBar .search trägt den Kontrollrand --line-control", () => {
    // FR-3.1: --line (1.42 auf --bg-1) ist dekorativ, der input-container
    // braucht den Kontrollrand.
    const block = ruleBlock(readRepoFile("src/ui/components/FilterBar.vue"), ".search");
    expect(block).toContain("border: 1px solid var(--line-control)");
  });

  it("SelectBox .sb-list trägt den Kontrollrand --line-control", () => {
    // FR-3.1: derselbe Fall für den popup-rand.
    const block = ruleBlock(readRepoFile("src/ui/components/SelectBox.vue"), ".sb-list");
    expect(block).toContain("border: 1px solid var(--line-control)");
  });

  it("ConfirmDialog .btn:focus-visible ringt mit --signal, nie mit --signal-dim", () => {
    // FR-3.2 / C5: --signal-dim liegt auf --bg-1 bei 2.03 und ist als
    // fokusring unbrauchbar.
    const source = readRepoFile("src/ui/components/ConfirmDialog.vue");
    const block = ruleBlock(source, ".btn:focus-visible, .btn.ghost:focus-visible");
    expect(block).toContain("outline: 2px solid var(--signal)");
    expect(flattenCss(source)).not.toMatch(/outline:\s*[^;]*var\(--signal-dim\)/);
  });

  it("ConfirmDialog .backdrop nutzt --overlay", () => {
    const block = ruleBlock(readRepoFile("src/ui/components/ConfirmDialog.vue"), ".backdrop");
    expect(block).toContain("background: var(--overlay)");
  });

  it("CleanupRow .sc-warn nutzt --warning-text", () => {
    // FR-3.5: nur der textliteral wird getauscht, fläche und rand bleiben
    // bis P3 auf --tier-gold.
    const source = readRepoFile("src/ui/components/CleanupRow.vue");
    expect(ruleBlock(source, ".sc-warn")).toContain("color: var(--warning-text)");
    expect(source).not.toContain("#f5d678");
  });
});

describe("Erster Paint (4.16)", () => {
  it("index.html trägt keine statische Sprache mehr", () => {
    expect(readRepoFile("index.html")).not.toMatch(/<html[^>]*\blang\s*=/i);
  });

  it("der erste-Paint-Hintergrund entspricht --bg-0", () => {
    const background = /background:\s*(#[0-9a-fA-F]{6})/.exec(readRepoFile("index.html"))?.[1];
    expect(tokenValue("--bg-0")).toBeDefined();
    expect(background?.toLowerCase()).toBe(tokenValue("--bg-0")?.toLowerCase());
  });
});
