// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readRepoFile } from "../support/themeTokens";

/** P17a/FR-1 (2.1, 4.13): nur die im audit belegten, wortgleichen Paare
 *  wandern nach `tokens.css`. Der Pin zählt deshalb genau eine Definition je
 *  regel und verlangt, dass die bisherigen eigentümer sie nicht mehr führen. */

const DRAWER = "src/ui/components/GameDetailDrawer.vue";
const FOOTPRINT = "src/ui/components/GameFootprintSection.vue";

const SHARED = [
  {
    name: ".blocked (OrphanPanel/TrashPanel/CleanupNotices)",
    selectors: [".blocked:not(.blocked-explanation)"],
    owners: [
      "src/ui/components/OrphanPanel.vue",
      "src/ui/components/TrashPanel.vue",
      "src/ui/components/CleanupNotices.vue",
    ],
  },
  {
    name: ".sel-all (OrphanPanel/TrashPanel/CleanupView)",
    selectors: [
      ".sel-all",
      ".sel-all:hover:not(:disabled)",
      ".sel-all:disabled",
      ".sel-all:focus-visible",
    ],
    owners: [
      "src/ui/components/OrphanPanel.vue",
      "src/ui/components/TrashPanel.vue",
      "src/ui/views/CleanupView.vue",
    ],
  },
  {
    name: ".save (GameDetailDrawer/GameFootprintSection)",
    selectors: [".save", ".save:hover:not(:disabled)", ".save:disabled", ".save:focus-visible"],
    owners: [DRAWER, FOOTPRINT],
  },
  {
    name: ".section-label (GameDetailDrawer/GameFootprintSection)",
    selectors: [
      ".section-label",
      ".section-label-explained",
      ".section-label-explained .section-label",
    ],
    owners: [DRAWER, FOOTPRINT],
  },
  {
    name: ".k (GameDetailDrawer/GameFootprintSection)",
    selectors: [".k"],
    owners: [DRAWER, FOOTPRINT],
  },
  {
    name: ".hint (GameDetailDrawer/GameFootprintSection)",
    selectors: [".drawer .hint, .footprint .hint"],
    owners: [DRAWER, FOOTPRINT],
  },
];

/** Kommentare raus, jede whitespace-folge auf ein leerzeichen. */
function flatten(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
}

/** Zählt Regeln, deren Selektor exakt `selector` ist (keine präfix-treffer). */
function ruleCount(source: string, selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[{};]) ?${escaped} \\{`, "g");
  return [...flatten(source).matchAll(pattern)].length;
}

describe("CSS-Dedup: geteilte Klassen (2.1, 4.13)", () => {
  const tokens = readRepoFile("src/ui/tokens.css");

  for (const { name, selectors, owners } of SHARED) {
    it(`${name}: genau eine Definition in tokens.css`, () => {
      for (const selector of selectors) {
        expect(ruleCount(tokens, selector), `${selector} in tokens.css`).toBe(1);
        for (const owner of owners) {
          expect(ruleCount(readRepoFile(owner), selector), `${owner}: ${selector}`).toBe(0);
        }
      }
    });
  }

  it("führt .blocked und .hint nicht nach Klassennamen zusammen", () => {
    // BlockedExplanation trägt `blocked` nur als tone-marke, HistoryView und
    // ProtonManagerView haben eigene .hint-formen: keine bare regel.
    expect(ruleCount(tokens, ".blocked")).toBe(0);
    expect(ruleCount(tokens, ".hint")).toBe(0);
  });

  it("CleanupView behält die eigene .hint-Form", () => {
    const view = readRepoFile("src/ui/views/CleanupView.vue");
    expect(ruleCount(view, ".hint")).toBe(1);
    expect(flatten(view)).toMatch(/\.hint \{ [^}]*color: var\(--tier-gold\)/);
  });
});
