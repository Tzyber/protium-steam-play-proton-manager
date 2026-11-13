// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { declarationValue, ruleBlock } from "../support/cssRules";
import { readRepoFile } from "../support/themeTokens";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const TIER_ALLOWLIST = new Set([
  "src/ui/tokens.css",
  "src/ui/tier.ts",
  "src/ui/components/TierBadge.vue",
  "src/ui/components/FilterBar.vue",
]);

function walkUiFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkUiFiles(full));
    } else if (entry.isFile() && /\.(vue|css|ts)$/.test(entry.name)) {
      files.push(path.relative(REPO_ROOT, full).replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

describe("P3 Gate: Tier-Farben bleiben auf ProtonDB beschränkt", () => {
  it("außerhalb der Allowlist nutzt keine UI-Datei --tier-*", () => {
    const hits: string[] = [];
    for (const rel of walkUiFiles(path.join(REPO_ROOT, "src/ui"))) {
      if (TIER_ALLOWLIST.has(rel)) continue;
      const lines = readFileSync(path.join(REPO_ROOT, rel), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/--tier-/.test(line)) {
          hits.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("ReleaseRow .tag.ok nutzt alle drei --success-*-Tokens", () => {
    const block = ruleBlock(readRepoFile("src/ui/components/ReleaseRow.vue"), ".tag.ok");
    expect(declarationValue(block, "color")).toBe("var(--success-text)");
    expect(declarationValue(block, "background")).toBe("var(--success-surface)");
    expect(declarationValue(block, "border")).toBe("1px solid var(--success-border)");
  });
});
