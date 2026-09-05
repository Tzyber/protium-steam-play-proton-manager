import { afterEach, describe, expect, it } from "vitest";
import { projectSupportFacts } from "../../src/core/support.js";
import type { CompatTool, Game, ScanResult } from "../../src/core/types.js";
import { setLocale } from "../../src/ui/i18n/index.js";
import { formatSupportFacts } from "../../src/ui/supportText.js";

function game(overrides: Partial<Game> = {}): Game {
  return {
    appId: 620,
    name: "Portal 2",
    library: "/steam/library",
    compatTool: "proton_experimental",
    compatToolSource: "explicit",
    protonDb: { tier: "gold", confidence: "strong" },
    localHeader: null,
    headerImage: null,
    ...overrides,
  };
}

function customTool(name: string, internalName = name): CompatTool {
  return {
    name,
    internalName,
    displayName: name,
    sizeBytes: 100,
    usedBy: [],
    source: "user",
  };
}

function result(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    steamRoot: "/steam",
    libraries: ["/steam/library"],
    games: [],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: null,
    compatConfigStatus: "available",
    steamUserId: null,
    launchConfigStatus: "available",
    manifestCounts: { read: 1, failed: 0 },
    compatToolCounts: { read: 1, failed: 0 },
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
    blockedAppIds: [],
    ...overrides,
  };
}

afterEach(() => setLocale("en"));

describe("formatSupportFacts", () => {
  it.each(["de", "en"] as const)("formatiert die echte Faktenprojektion in %s", (locale) => {
    setLocale(locale);
    const marker = "fixture-secret-934";
    const privatePath = "/home/fixture-private-user/.steam/userdata/76561198012345678";
    const currentGame = game({
      name: `Game ${marker}`,
      library: `${privatePath}/steamapps/common/Game`,
      compatTool: marker,
      protonDb: { tier: "gold", confidence: marker },
      localHeader: `https://${marker}/header.png`,
      headerImage: `https://${marker}/fallback.png`,
      launchOptions: `STEAM_COMPAT_DATA_PATH=${privatePath}/${marker} %command%`,
    });
    const scan = result({
      steamRoot: privatePath,
      libraries: [currentGame.library],
      games: [currentGame],
      compatToolsInstalled: [customTool(marker)],
      warnings: [
        {
          type: "manifest",
          library: marker,
          manifestName: marker,
          reason: "invalid-content",
          detail: marker,
        },
      ],
    });
    const facts = projectSupportFacts({
      game: currentGame,
      result: scan,
      footprint: { summary: { status: "partial", sizeBytes: 4096 } },
      cleanup: {
        scanning: true,
        prefixUnavailable: true,
        incompleteDeletionsCount: 2,
        incompleteDeletionsUnreadable: true,
      },
    });
    const text = formatSupportFacts(facts, "0.7.1");

    expect(text).toContain("Protium: 0.7.1");
    expect(text).toContain("620");
    expect(text).toContain("<steam-library-1>");
    expect(text).toContain("<compat-tool-1>");
    expect(text).toContain(locale === "de" ? "lokaler Scan" : "local scan");
    expect(text).toContain(locale === "de" ? "ProtonDB-Tier" : "ProtonDB tier");
    expect(text).toContain(locale === "de" ? "lokale Messung" : "local measurement");
    expect(text).toContain(
      locale === "de" ? "vorhandener Anzeigestand" : "existing displayed state",
    );
    expect(text).toContain(locale === "de" ? "Prüfung läuft" : "check in progress");
    expect(text).not.toContain(marker);
    expect(text).not.toContain(privatePath);
    expect(text).not.toContain("/steam/library");
  });

  it("trennt unbekannte Config-, Tool-, Community-, Mess- und Cleanup-Zustände", () => {
    setLocale("de");
    const currentGame = game({
      appId: 620,
      compatTool: "default",
      compatToolSource: "unavailable",
      protonDb: null,
    });
    const scan = result({
      games: [currentGame],
      compatConfigStatus: "missing",
      launchConfigStatus: "ambiguous",
    });
    const facts = projectSupportFacts({
      game: currentGame,
      result: scan,
      cleanup: {},
    });

    const text = formatSupportFacts(facts, "0.7.1");
    expect(text).toContain("Kompatibilitäts-Config: nicht gefunden");
    expect(text).toContain("Startoptionen-Quelle: mehrdeutig");
    expect(text).toContain("Zugeordnetes Tool: unbekannt");
    expect(text).toContain("Tool verfügbar: unbekannt");
    expect(text).toContain("ProtonDB-Tier: unbekannt");
    expect(text).toContain("Bekannt belegt: nicht gemessen");
    expect(text).toContain("Externer Compatdata-Hinweis: unbekannt");
    expect(text).toContain("abgebrochene Löschung: unbekannt");
    expect(text).toContain("Bereinigungsfreigabe: unbekannt");
    expect(text).not.toContain("kein externer Pfad");
    expect(text).not.toContain("0 Byte");
  });

  it.each([
    ["de", "Scan-Abdeckung: unvollständig", "Scan-Abdeckung: eingeschränkt"],
    ["en", "Scan coverage: incomplete", "Scan coverage: limited"],
  ] as const)(
    "exportiert einen unvollständigen Scan als unvollständig in %s",
    (locale, incomplete, limited) => {
      setLocale(locale);
      const currentGame = game();
      const facts = projectSupportFacts({
        game: currentGame,
        result: result({
          games: [currentGame],
          skippedLibraries: [{ path: "/steam/second", reason: "path-missing" }],
        }),
        cleanup: {},
      });

      expect(facts.scanCoverage).toBe("incomplete");
      const text = formatSupportFacts(facts, "0.7.1");
      expect(text).toContain(incomplete);
      expect(text).not.toContain(limited);
    },
  );

  it.each([
    ["de", "Scan-Abdeckung: eingeschränkt"],
    ["en", "Scan coverage: limited"],
  ] as const)("exportiert eine fehlende Config als eingeschränkt in %s", (locale, limited) => {
    setLocale(locale);
    const currentGame = game();
    const facts = projectSupportFacts({
      game: currentGame,
      result: result({ games: [currentGame], compatConfigStatus: "missing" }),
      cleanup: {},
    });

    expect(facts.scanCoverage).toBe("limited");
    expect(formatSupportFacts(facts, "0.7.1")).toContain(limited);
  });

  it.each(["de", "en"] as const)(
    "formatiert bekannte Nullsummen für complete und partial in %s als 0 B",
    (locale) => {
      setLocale(locale);
      const currentGame = game();
      const scan = result({ games: [currentGame] });
      const expected =
        locale === "de"
          ? {
              complete: "Bekannt belegt: 0 B (Quelle:",
              partial: "Bekannt belegt: 0 B (teilweise; Quelle:",
            }
          : {
              complete: "Known footprint: 0 B (source:",
              partial: "Known footprint: 0 B (partial; source:",
            };

      for (const status of ["complete", "partial"] as const) {
        const facts = projectSupportFacts({
          game: currentGame,
          result: scan,
          footprint: { summary: { status, sizeBytes: 0 } },
        });
        expect(formatSupportFacts(facts, "0.7.1")).toContain(expected[status]);
      }
    },
  );

  it("zeigt positive Cleanup-Beobachtungen mit Zählung, aber ohne Pfade", () => {
    setLocale("en");
    const currentGame = game();
    const facts = projectSupportFacts({
      game: currentGame,
      result: result({ games: [currentGame] }),
      cleanup: {
        prefixUnavailable: true,
        shaderUnavailable: true,
        trashUnavailable: true,
        incompleteDeletionsCount: 3,
        incompleteDeletionsUnreadable: true,
      },
    });

    const text = formatSupportFacts(facts, "0.7.1");
    expect(text).toContain("Cleanup blocked (existing displayed state)");
    expect(text).toContain("incomplete deletion: 3 (existing displayed state)");
    expect(text).toContain("claim check: incomplete");
    expect(text).not.toContain("/steam");
  });
});
