import { describe, expect, it } from "vitest";
import type { PendingDeleteInfo } from "../../src/core/ports";
import { localizeConsequences } from "../../src/ui/consequences";
import { setLocale } from "../../src/ui/i18n";

function pending(overrides: Partial<PendingDeleteInfo>): PendingDeleteInfo {
  return {
    token: "t",
    expiresAt: 0,
    targetType: "orphan",
    targetPath: "/lib/steamapps/compatdata/620",
    consequences: [],
    ...overrides,
  };
}

describe("localizeConsequences", () => {
  it("englisch: keine deutschen konsequenz-strings im dialog", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "orphan",
        consequences: [
          {
            path: "/lib/steamapps/compatdata/620",
            action: "trash",
            description: "Prefix von app 620 in den Papierkorb verschieben",
            affectedAppIds: [620],
          },
          {
            path: "/lib/steamapps/shadercache/620",
            action: "permanentDelete",
            description: "Shader-Cache von app 620 dauerhaft löschen",
            affectedAppIds: [620],
          },
        ],
      }),
      "Half-Life",
    );
    expect(lines).toEqual([
      "Move prefix of Half-Life to trash",
      "Permanently delete shader cache of Half-Life",
    ]);
    for (const line of lines) {
      expect(line).not.toMatch(/Papierkorb|löschen|dauerhaft|Prefix|Shader/);
    }
  });

  it("deutsch bleibt korrekt und fällt ohne name auf die app-id zurück", () => {
    setLocale("de");
    const lines = localizeConsequences(
      pending({
        targetType: "orphan",
        consequences: [
          {
            path: "/lib/steamapps/compatdata/620",
            action: "trash",
            description: "Prefix von app 620 in den Papierkorb verschieben",
            affectedAppIds: [620],
          },
        ],
      }),
    );
    expect(lines).toEqual(["Prefix von 620 in den Papierkorb verschieben"]);
  });

  it("englisch: ohne name fällt der orphan auf die app-id zurück", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "orphan",
        consequences: [
          {
            path: "/lib/steamapps/shadercache/620",
            action: "permanentDelete",
            description: "Shader-Cache von app 620 dauerhaft löschen",
            affectedAppIds: [620],
          },
        ],
      }),
    );
    expect(lines).toEqual(["Permanently delete shader cache of 620"]);
  });

  it("papierkorb-eintrag nutzt den verzeichnisnamen aus dem pfad", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "trash",
        targetPath: "/lib/steamapps/.protium-trash/compatdata_620_123",
        consequences: [
          {
            path: "/lib/steamapps/.protium-trash/compatdata_620_123",
            action: "permanentDelete",
            description: "Papierkorb-Eintrag compatdata_620_123 dauerhaft löschen",
          },
        ],
      }),
    );
    expect(lines).toEqual(["Permanently delete trash entry compatdata_620_123"]);
  });

  it("compat-tool nennt mit affectedAppIds tool-namen und zahl der spiele", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "compatTool",
        targetPath: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
        consequences: [
          {
            path: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
            action: "permanentDelete",
            description: "GE-Proton-Tool GE-Proton9-27 dauerhaft löschen",
            affectedAppIds: [620, 730],
          },
        ],
      }),
    );
    expect(lines).toEqual(["Permanently delete GE-Proton tool GE-Proton9-27 (assigned games: 2)"]);
  });

  it("compat-tool als globaler standard ergänzt eine eigene zeile", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "compatTool",
        targetPath: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
        consequences: [
          {
            path: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
            action: "permanentDelete",
            description: "GE-Proton-Tool GE-Proton9-27 dauerhaft löschen",
            affectsGlobalDefault: true,
          },
        ],
      }),
    );
    expect(lines).toEqual([
      "Permanently delete GE-Proton tool GE-Proton9-27",
      "This tool is Steam's default; games without their own assignment lose their tool",
    ]);
  });

  it("compat-tool ohne affectedAppIds nutzt weiter die zeile ohne zahl", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "compatTool",
        targetPath: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
        consequences: [
          {
            path: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
            action: "permanentDelete",
            description: "GE-Proton-Tool GE-Proton9-27 dauerhaft löschen",
          },
        ],
      }),
    );
    expect(lines).toEqual(["Permanently delete GE-Proton tool GE-Proton9-27"]);
  });

  it("impactUnknown: unbekannte app-liste ersetzt die zahl und bleibt neben der aktion sichtbar", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "compatTool",
        targetPath: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
        consequences: [
          {
            path: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
            action: "permanentDelete",
            description: "GE-Proton-Tool GE-Proton9-27 dauerhaft löschen",
            affectedAppIds: [620, 730],
            impactUnknown: true,
          },
        ],
      }),
    );
    expect(lines).toEqual([
      "Permanently delete GE-Proton tool GE-Proton9-27",
      "Affected apps unknown (tool VDF unreadable): GE-Proton9-27",
    ]);
  });

  it("impactUnknown: die globale zeile kommt nur bei affectsGlobalDefault === true dazu", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "compatTool",
        targetPath: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
        consequences: [
          {
            path: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
            action: "permanentDelete",
            description: "GE-Proton-Tool GE-Proton9-27 dauerhaft löschen",
            impactUnknown: true,
            affectsGlobalDefault: true,
          },
        ],
      }),
    );
    expect(lines).toEqual([
      "Permanently delete GE-Proton tool GE-Proton9-27",
      "Affected apps unknown (tool VDF unreadable): GE-Proton9-27",
      "This tool is Steam's default; games without their own assignment lose their tool",
    ]);
  });

  it("impactUnknown false mit leerer liste bleibt die zeile ohne zahl", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "compatTool",
        targetPath: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
        consequences: [
          {
            path: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
            action: "permanentDelete",
            description: "GE-Proton-Tool GE-Proton9-27 dauerhaft löschen",
            affectedAppIds: [],
            impactUnknown: false,
          },
        ],
      }),
    );
    expect(lines).toEqual(["Permanently delete GE-Proton tool GE-Proton9-27"]);
  });

  it("legacy-payload ohne impactUnknown behält die bisherige zeile", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "compatTool",
        targetPath: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
        consequences: [
          {
            path: "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
            action: "permanentDelete",
            description: "GE-Proton-Tool GE-Proton9-27 dauerhaft löschen",
            affectedAppIds: [620, 730],
          },
        ],
      }),
    );
    expect(lines).toEqual(["Permanently delete GE-Proton tool GE-Proton9-27 (assigned games: 2)"]);
  });

  it("unbekannte struktur nutzt übersetzten fallback ohne backend-rohtext (A-09)", () => {
    setLocale("en");
    const enLines = localizeConsequences(
      pending({
        targetType: "orphan",
        targetPath: "/lib/steamapps/compatdata/999",
        consequences: [
          {
            path: "/lib/steamapps/compatdata/620",
            action: "unexpectedAction" as "trash",
            description: "backend-autorität bleibt sichtbar",
            affectedAppIds: [1],
          },
          {
            path: "",
            action: "unexpectedAction" as "trash",
            description: "backend-autorität bleibt sichtbar",
          },
        ],
      }),
    );
    expect(enLines).toEqual(["Remove entry 620", "Remove entry 999"]);
    expect(enLines.join("\n")).not.toContain("backend-autorität bleibt sichtbar");

    setLocale("de");
    const deLines = localizeConsequences(
      pending({
        targetType: "orphan",
        consequences: [
          {
            path: "/lib/steamapps/compatdata/620",
            action: "unexpectedAction" as "trash",
            description: "backend-autorität bleibt sichtbar",
          },
        ],
      }),
    );
    expect(deLines).toEqual(["Eintrag 620 entfernen"]);
  });

  it("orphan ohne name und affectedAppIds nutzt nur den basisnamen des pfads (A-09)", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "orphan",
        targetPath: "/lib/steamapps/compatdata/620",
        consequences: [
          {
            path: "/lib/steamapps/compatdata/620",
            action: "trash",
            description: "Move prefix to trash",
          },
        ],
      }),
    );
    expect(lines).toEqual(["Move prefix of 620 to trash"]);
    expect(lines[0]).not.toContain("/lib/steamapps");
  });

  it("extraktionsrest nutzt lokalisierten dauerhaft-löschen-text", () => {
    setLocale("de");
    expect(
      localizeConsequences(
        pending({
          targetType: "extractLeftover",
          targetPath: "/root/compatibilitytools.d/.protium-extract-123-abc",
          consequences: [
            {
              path: "/root/compatibilitytools.d/.protium-extract-123-abc",
              action: "permanentDelete",
              description: "backend text",
            },
          ],
        }),
      ),
    ).toEqual(["Unvollständigen Extraktionsrest .protium-extract-123-abc dauerhaft löschen"]);

    setLocale("en");
    expect(
      localizeConsequences(
        pending({
          targetType: "extractLeftover",
          targetPath: "/root/compatibilitytools.d/.protium-extract-123-abc",
          consequences: [
            {
              path: "/root/compatibilitytools.d/.protium-extract-123-abc",
              action: "permanentDelete",
              description: "backend text",
            },
          ],
        }),
      ),
    ).toEqual(["Permanently delete incomplete extraction leftover .protium-extract-123-abc"]);
  });
});
