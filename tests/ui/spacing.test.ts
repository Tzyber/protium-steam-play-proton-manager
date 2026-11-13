// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { declarationValue, ruleBlock } from "../support/cssRules";
import { readRepoFile } from "../support/themeTokens";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const SPACING_PROP_RE =
  /(?:^|[;{\s])(gap|row-gap|column-gap|padding(?:-[a-z]+)*|margin(?:-[a-z]+)*|scroll-margin(?:-[a-z]+)*|inset(?:-[a-z]+)*)\s*:\s*([^;}{]+);/gm;

function listStyleTargets(): Array<{ rel: string; css: string }> {
  const targets: Array<{ rel: string; css: string }> = [];
  const tokensRaw = readRepoFile("src/ui/tokens.css");
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

function isAllowedSpacingLiteral(rel: string, prop: string, val: string): boolean {
  if (rel === "src/ui/tokens.css" && prop === "margin" && val === "-1px") return true;
  if (rel === "src/ui/views/CleanupView.vue" && prop === "margin-bottom" && val === "-1px") {
    return true;
  }
  if (rel === "src/ui/components/PlayButton.vue" && prop === "margin-left" && val === "1px") {
    return true;
  }
  return false;
}

describe("P5a Gate: Abstände nutzen --space-*-Tokens", () => {
  it("keine literalen px/rem/em-Werte in gap/padding/margin/scroll-margin/inset", () => {
    const violations: string[] = [];
    for (const { rel, css } of listStyleTargets()) {
      const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of clean.matchAll(SPACING_PROP_RE)) {
        const prop = match[1]?.trim() ?? "";
        const val = match[2]?.trim() ?? "";
        if (
          /[0-9]+(?:\.[0-9]+)?(?:px|rem|em)\b/.test(val) &&
          !isAllowedSpacingLiteral(rel, prop, val)
        ) {
          violations.push(`${rel}: ${prop}: ${val}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("--gap-Alias ist entfernt und Sidebar-Nav hält L9 (--space-1)", () => {
    const tokens = readRepoFile("src/ui/tokens.css");
    expect(tokens).not.toMatch(/--gap\s*:/);
    const nav = ruleBlock(readRepoFile("src/ui/components/AppSidebar.vue"), "nav");
    expect(declarationValue(nav, "gap")).toBe("var(--space-1)");
  });
});
