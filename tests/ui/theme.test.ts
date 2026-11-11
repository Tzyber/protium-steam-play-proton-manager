// @vitest-environment node
import { describe, expect, it } from "vitest";
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

  it("die gemeinsame .blocked-Form und CleanupViews Danger-Aktion nutzen die Tokens", () => {
    // P17a/FR-1: die wortgleiche .blocked-form der drei Cleanup-Panels steht
    // jetzt einmal in tokens.css statt dreimal in den komponenten.
    const tokens = readRepoFile("src/ui/tokens.css");
    expect(tokens).toMatch(/color:\s*var\(--danger-fg\)/);
    expect(tokens).toMatch(/(?:background|border):[^;]*var\(--danger\)/);

    const cleanupView = readRepoFile("src/ui/views/CleanupView.vue");
    expect(cleanupView).toMatch(/color:\s*var\(--danger-fg\)/);
    expect(cleanupView).toMatch(/(?:background|border):[^;]*var\(--danger\)/);
  });

  it("ConfirmDialog nutzt die Danger-Tokens statt eigener Literale", () => {
    const source = readRepoFile("src/ui/components/ConfirmDialog.vue");
    expect(source).not.toContain("#c03940");
    expect(source).not.toContain("#a93238");
    expect(source).toMatch(/border:[^;]*var\(--danger\)/);
    expect(source).toMatch(/background:\s*var\(--danger\)/);
    expect(source).toMatch(/:hover[^}]*var\(--danger-hover\)/);
    expect(source).toMatch(/color:\s*#fff/);
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
