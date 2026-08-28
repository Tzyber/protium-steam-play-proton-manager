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
    );
    expect(lines).toEqual([
      "Move prefix of app 620 to trash",
      "Permanently delete shader cache of app 620",
    ]);
    for (const line of lines) {
      expect(line).not.toMatch(/Papierkorb|löschen|dauerhaft|Prefix|Shader/);
    }
  });

  it("deutsch bleibt korrekt", () => {
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
    expect(lines).toEqual(["Prefix von app 620 in den Papierkorb verschieben"]);
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

  it("compat-tool nutzt den tool-namen aus dem pfad", () => {
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
            affectedAppIds: [620],
          },
        ],
      }),
    );
    expect(lines).toEqual(["Permanently delete GE-Proton tool GE-Proton9-27"]);
  });

  it("unbekannte struktur fällt auf den backend-string zurück", () => {
    setLocale("en");
    const lines = localizeConsequences(
      pending({
        targetType: "orphan",
        consequences: [
          {
            path: "/x",
            action: "unexpectedAction" as "trash",
            description: "backend-autorität bleibt sichtbar",
            affectedAppIds: [1],
          },
        ],
      }),
    );
    expect(lines).toEqual(["backend-autorität bleibt sichtbar"]);
  });
});
