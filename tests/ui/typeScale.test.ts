// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { declarationValue, ruleBlock } from "../support/cssRules";
import { readRepoFile } from "../support/themeTokens";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function listStyleTargets(): Array<{ rel: string; css: string }> {
  const targets: Array<{ rel: string; css: string }> = [];
  const tokensRaw = readRepoFile("src/ui/tokens.css");
  // Alles nach dem schließenden `}` des ersten `:root { ... }` Blocks prüfen.
  const rootEnd = tokensRaw.indexOf("\n}\n");
  expect(rootEnd).toBeGreaterThan(0);
  targets.push({ rel: "src/ui/tokens.css", css: tokensRaw.slice(rootEnd + 3) });

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".vue")) {
        const content = readFileSync(full, "utf8");
        const styleMatches = [...content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)];
        const css = styleMatches.map((m) => m[1] ?? "").join("\n");
        targets.push({ rel: path.relative(REPO_ROOT, full).replace(/\\/g, "/"), css });
      }
    }
  }
  walk(path.join(REPO_ROOT, "src/ui"));
  return targets.sort((a, b) => a.rel.localeCompare(b.rel));
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("P4 Gate: Type-Scale, Tracking, Leading und font-synthesis", () => {
  it("tokens.css setzt font-synthesis: none und definiert --tracking-tight", () => {
    const tokens = readRepoFile("src/ui/tokens.css");
    const rootBlock = ruleBlock(tokens, ":root");
    expect(declarationValue(rootBlock, "font-synthesis")).toBe("none");
    expect(declarationValue(rootBlock, "--tracking-tight")).toBe("-0.01em");
  });

  it("alle font-size-Deklarationen nutzen --text-* oder --icon-*", () => {
    const violations: string[] = [];
    for (const { rel, css } of listStyleTargets()) {
      const clean = stripCssComments(css);
      for (const match of clean.matchAll(/font-size\s*:\s*([^;}{]+);/g)) {
        const val = match[1]?.trim() ?? "";
        if (!/^var\(--(text|icon)-[a-z0-9-]+\)$/.test(val)) {
          violations.push(`${rel}: font-size: ${val}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("alle letter-spacing-Deklarationen nutzen --tracking-*", () => {
    const violations: string[] = [];
    for (const { rel, css } of listStyleTargets()) {
      const clean = stripCssComments(css);
      for (const match of clean.matchAll(/letter-spacing\s*:\s*([^;}{]+);/g)) {
        const val = match[1]?.trim() ?? "";
        if (!/^var\(--tracking-[a-z0-9-]+\)$/.test(val)) {
          violations.push(`${rel}: letter-spacing: ${val}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("alle line-height-Deklarationen nutzen --leading-* oder 1", () => {
    const violations: string[] = [];
    for (const { rel, css } of listStyleTargets()) {
      const clean = stripCssComments(css);
      for (const match of clean.matchAll(/line-height\s*:\s*([^;}{]+);/g)) {
        const val = match[1]?.trim() ?? "";
        if (val !== "1" && !/^var\(--leading-[a-z0-9-]+\)$/.test(val)) {
          violations.push(`${rel}: line-height: ${val}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keine font:-Shorthands (außer font: inherit) und kein font-style: italic", () => {
    const violations: string[] = [];
    for (const { rel, css } of listStyleTargets()) {
      const clean = stripCssComments(css);
      for (const match of clean.matchAll(/(?:^|[;\s{])font\s*:\s*([^;}{]+);/gm)) {
        const val = match[1]?.trim() ?? "";
        if (val !== "inherit") {
          violations.push(`${rel}: font: ${val}`);
        }
      }
      if (/font-style\s*:\s*italic\b/.test(clean)) {
        violations.push(`${rel}: font-style: italic`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("Gewichtsinvariante für gebündelte Schnitte unter font-synthesis: none", () => {
    const tokens = readRepoFile("src/ui/tokens.css");
    expect(declarationValue(ruleBlock(tokens, ".label"), "font-weight")).toBe("400");
    expect(declarationValue(ruleBlock(tokens, ".section-label"), "font-family")).toBe(
      "var(--font-body)",
    );
    expect(declarationValue(ruleBlock(tokens, ".section-label"), "font-weight")).toBe("600");
    expect(declarationValue(ruleBlock(tokens, ".section-label.mono"), "font-family")).toBe(
      "var(--font-mono)",
    );
    expect(declarationValue(ruleBlock(tokens, ".section-label.mono"), "font-weight")).toBe("700");
    expect(
      declarationValue(
        ruleBlock(tokens, ".blocked:not(.blocked-explanation) strong"),
        "font-weight",
      ),
    ).toBe("600");

    expect(
      declarationValue(
        ruleBlock(readRepoFile("src/ui/views/CleanupView.vue"), ".tab-count"),
        "font-weight",
      ),
    ).toBe("400");
    expect(
      declarationValue(
        ruleBlock(readRepoFile("src/ui/components/ScanCoveragePanel.vue"), ".coverage-group h2"),
        "font-weight",
      ),
    ).toBe("700");
    expect(
      declarationValue(
        ruleBlock(readRepoFile("src/ui/components/ScanCoveragePanel.vue"), ".coverage-alert"),
        "font-weight",
      ),
    ).toBe("600");
    expect(
      declarationValue(
        ruleBlock(readRepoFile("src/ui/views/ProtonManagerView.vue"), ".rsub"),
        "font-weight",
      ),
    ).toBe("400");
    expect(
      declarationValue(
        ruleBlock(readRepoFile("src/ui/components/ReleaseRow.vue"), ".rsub"),
        "font-weight",
      ),
    ).toBe("400");
    expect(
      declarationValue(
        ruleBlock(readRepoFile("src/ui/components/GameDetailDrawer.vue"), ".pdb-link"),
        "font-weight",
      ),
    ).toBe("700");
    const scWarn = ruleBlock(readRepoFile("src/ui/components/CleanupRow.vue"), ".sc-warn");
    expect(declarationValue(scWarn, "font-family")).toBe("var(--font-body)");
    expect(declarationValue(scWarn, "font-weight")).toBe("600");

    // Saira bündelt nur 600/700: geerbte 400-Untertitel brauchen --font-body.
    for (const [file, selector] of [
      ["src/ui/views/LibraryView.vue", ".title .unit"],
      ["src/ui/views/ProtonManagerView.vue", ".section .count"],
      ["src/ui/components/OrphanPanel.vue", ".section .count"],
      ["src/ui/components/TrashPanel.vue", ".section .count"],
    ] as const) {
      const rule = ruleBlock(readRepoFile(file), selector);
      expect(declarationValue(rule, "font-family"), `${file} ${selector}`).toBe("var(--font-body)");
      expect(declarationValue(rule, "font-weight"), `${file} ${selector}`).toBe("400");
    }
  });
});
