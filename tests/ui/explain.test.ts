import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPLAIN_TOPICS, type ExplainTopic } from "../../src/ui/explain.js";
import { setLocale, t } from "../../src/ui/i18n/index.js";

const GLOSSARY = readFileSync(resolve(process.cwd(), "docs/glossar.md"), "utf8");
const TOPICS: readonly ExplainTopic[] = [
  "compat-tool",
  "compat-source",
  "global-default",
  "config-unavailable",
  "protondb",
  "scan-coverage",
  "tool-unrecognized",
  "footprint",
  "external-compatdata",
  "cleanup-blocked",
  "steam-owned",
  "incomplete-deletion",
];

describe("Explain-Registry", () => {
  it("registriert genau die zwölf typisierten Topics", () => {
    expect(Object.keys(EXPLAIN_TOPICS).sort()).toEqual([...TOPICS].sort());
  });

  it("bindet jedes Topic an de/en-Texte und vorhandene Glossarzeilen", () => {
    for (const topic of TOPICS) {
      const definition = EXPLAIN_TOPICS[topic];

      for (const locale of ["de", "en"] as const) {
        setLocale(locale);
        for (const key of [
          definition.titleKey,
          definition.sourceKey,
          definition.meaningKey,
          definition.limitKey,
        ]) {
          expect(t(key)).not.toBe(key);
          expect(t(key).trim().length).toBeGreaterThan(0);
        }
      }

      for (const glossary of definition.glossary) {
        expect(GLOSSARY).toContain(`| ${glossary.de} | ${glossary.en} |`);
      }
    }
  });
});
