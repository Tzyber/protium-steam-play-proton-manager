import { afterEach, describe, expect, it } from "vitest";
import { projectSupportFacts, type SupportInput } from "../../src/core/support.js";
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
  it.each([
    ["de", "proton_experimental", "Proton Experimental"],
    ["en", "proton_experimental", "Proton Experimental"],
    ["de", "GE-Proton10-12", "GE-Proton10-12"],
    ["en", "GE-Proton10-12", "GE-Proton10-12"],
  ] as const)("exportiert in %s nur den freigegebenen Toolnamen %s", (locale, name, label) => {
    setLocale(locale);
    const marker = "fixture-secret-934";
    const accountId = "76561198012345678";
    const privatePath = `/home/fixture-private-user/.steam/userdata/${accountId}`;
    const currentGame = game({
      name: `Game ${marker}`,
      library: privatePath,
      compatTool: name,
      protonDb: { tier: "gold", confidence: marker },
      launchOptions: `TOKEN=${marker} STEAM_COMPAT_DATA_PATH=${privatePath} %command%`,
      localHeader: `https://${marker}/header.png`,
      headerImage: `https://${marker}/fallback.png`,
    });
    const facts = projectSupportFacts({
      game: currentGame,
      result: result({
        steamRoot: privatePath,
        steamUserId: accountId,
        libraries: [privatePath],
        games: [currentGame],
        compatToolsInstalled: [{ ...customTool(marker, name), displayName: marker }],
        warnings: [
          {
            type: "manifest",
            library: privatePath,
            manifestName: marker,
            reason: "invalid-content",
            detail: marker,
          },
        ],
      }),
    });
    const text = formatSupportFacts(facts, "0.8.0");

    expect(text).toContain(`Protium: 0.8.0\nAppID: 620\nLibrary: <steam-library-1>`);
    expect(text).toContain(`${locale === "de" ? "Zugeordnetes Tool" : "Assigned tool"}: ${label}`);
    for (const privateValue of [marker, privatePath, "fixture-private-user", accountId, "TOKEN="]) {
      expect(text).not.toContain(privateValue);
    }
    expect(
      text.endsWith(
        locale === "de"
          ? "Spielnamen und Pfade werden nicht exportiert. Steam-Libraries und Toolnamen außerhalb der Freigaberegeln erscheinen als Alias."
          : "Game names and paths are omitted. Steam libraries and tool names outside the allowlist rules are shown as aliases.",
      ),
    ).toBe(true);
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
});

describe.each(["de", "en"] as const)("kompakter Support-Beleg in %s", (locale) => {
  function render(input: Partial<SupportInput> = {}): string {
    setLocale(locale);
    const currentGame = input.game ?? game();
    return formatSupportFacts(
      projectSupportFacts({
        game: currentGame,
        result: result({ games: [currentGame] }),
        ...input,
      }),
      "0.9.0",
    );
  }

  it("bewahrt die vollständige Normalform als Snapshot", () => {
    const currentGame = game({
      appId: 668580,
      compatTool: "GE-Proton10-12",
      protonDb: { tier: "platinum", confidence: "strong" },
    });
    const text = render({
      game: currentGame,
      result: result({
        games: [currentGame],
        libraries: ["/steam/other-library", currentGame.library],
        compatToolsInstalled: [customTool("GE-Proton10-12")],
      }),
      footprint: { summary: { status: "complete", sizeBytes: 50_358_491_546 } },
      cleanup: { incompleteDeletionsCount: 0 },
    });
    expect(text).toMatchSnapshot();
    expect(text.split("\n\n")).toHaveLength(3);
  });

  it("bewahrt die degradierte Form als Snapshot ohne erfundene Scan-Unbekanntheit", () => {
    const text = render({
      game: game({ compatToolSource: "unavailable", protonDb: null }),
      result: result({ compatConfigStatus: "missing", launchConfigStatus: "ambiguous" }),
      cleanup: {},
    });
    expect(text).toMatchSnapshot();
    expect(text).toContain(
      locale === "de" ? "Scan-Abdeckung: eingeschränkt" : "Scan coverage: limited",
    );
    expect(text.split("\n\n")).toHaveLength(3);
  });

  it.each([
    ["missing", "nicht gefunden", "not found"],
    ["unreadable", "unlesbar", "unreadable"],
    [undefined, "unbekannt", "unknown"],
  ] as const)("erhält Config-Störung %s an der richtigen Stelle", (status, de, en) => {
    const lines = render({ result: result({ compatConfigStatus: status }) }).split("\n");
    expect(lines[5]).toBe(
      locale === "de"
        ? `Kompatibilitäts-Config: ${de} [Config]`
        : `Compatibility config: ${en} [config]`,
    );
    expect(lines).not.toContain(
      locale === "de" ? "Tool verfügbar: ja [lokaler Scan]" : "Tool available: yes [local scan]",
    );
  });

  it.each([
    ["missing", "nicht gefunden", "not found"],
    ["unreadable", "unlesbar", "unreadable"],
    ["ambiguous", "mehrdeutig", "ambiguous"],
    [undefined, "unbekannt", "unknown"],
  ] as const)(
    "erhält Startoptionen-Störung %s auch zusammen mit Config-Störung",
    (status, de, en) => {
      for (const configMissing of [false, true]) {
        const lines = render({
          result: result({
            compatConfigStatus: configMissing ? "missing" : "available",
            launchConfigStatus: status,
          }),
        }).split("\n");
        expect(lines[configMissing ? 6 : 5]).toBe(
          locale === "de"
            ? `Startoptionen-Quelle: ${de} [Config]`
            : `Launch-options source: ${en} [config]`,
        );
      }
    },
  );

  it.each([
    ["explicit", "explizite Zuordnung", "explicit mapping"],
    ["default", "globaler Standard", "global default"],
    ["unavailable", "Zuordnung: nicht verfügbar", "Mapping: not available"],
  ] as const)("bindet die tatsächliche Quelle %s an die Toolzeile", (source, de, en) => {
    const text = render({
      game: game({ compatToolSource: source }),
      result: result({ defaultCompatTool: "GE-Proton10-12" }),
    });
    const tool = {
      explicit: "Proton Experimental",
      default: "GE-Proton10-12",
      unavailable: locale === "de" ? "unbekannt" : "unknown",
    }[source];
    expect(text).toContain(
      locale === "de" ? `Zugeordnetes Tool: ${tool} [${de}]` : `Assigned tool: ${tool} [${en}]`,
    );
    expect(text).not.toContain(locale === "de" ? "Quelle der Zuordnung:" : "Assignment source:");
  });

  it.each([
    ["available", "ja", "yes"],
    ["not-recognized", "nicht erkannt", "not recognized"],
    ["unknown", "unbekannt", "unknown"],
  ] as const)("trennt Tool-Verfügbarkeit %s", (availability, de, en) => {
    const currentGame = game();
    const text = render({
      game: currentGame,
      result: result({
        games: [currentGame],
        builtinProtonsInstalled:
          availability === "available"
            ? [{ internalName: "proton_experimental", displayName: "private-display" }]
            : [],
        warnings:
          availability === "unknown"
            ? [{ type: "compat-tool", directory: "/steam/tools", reason: "directory-unreadable" }]
            : [],
      }),
    });
    expect(text).toContain(
      locale === "de"
        ? `Tool verfügbar: ${de} [lokaler Scan]`
        : `Tool available: ${en} [local scan]`,
    );
    expect(text.split("\n")).not.toContain(
      locale === "de" ? "Tool verfügbar: nein [lokaler Scan]" : "Tool available: no [local scan]",
    );
    expect(text).not.toContain(
      locale === "de" ? "Kompatibilitäts-Config:" : "Compatibility config:",
    );
    expect(text).not.toContain(
      locale === "de" ? "Startoptionen-Quelle:" : "Launch-options source:",
    );
    if (locale === "de") expect(text.match(/verfügbar/g)).toHaveLength(1);
  });

  it.each([
    ["platinum", "Platinum"],
    ["gold", "Gold"],
    ["silver", "Silver"],
    ["bronze", "Bronze"],
    ["borked", "Borked"],
    ["unknown", null],
  ] as const)("formatiert Tier %s", (tier, label) => {
    const text = render({ game: game({ protonDb: { tier, confidence: "private-confidence" } }) });
    expect(text).toContain(
      locale === "de"
        ? `ProtonDB-Tier: ${label ?? "unbekannt"} [Community-Befund]`
        : `ProtonDB tier: ${label ?? "unknown"} [community finding]`,
    );
  });

  it.each(["complete", "partial"] as const)(
    "bewahrt Messstatus %s mit Null und positiver Größe",
    (status) => {
      for (const sizeBytes of [0, 4096]) {
        const text = render({ footprint: { summary: { status, sizeBytes } } });
        const size = sizeBytes === 0 ? "0 B" : "4.0 KB";
        const partial =
          status === "partial" ? (locale === "de" ? " (teilweise)" : " (partial)") : "";
        expect(text).toContain(
          locale === "de"
            ? `Bekannt belegt: ${size}${partial} [lokale Messung und Existenzprüfung]`
            : `Known footprint: ${size}${partial} [local measurement and existence check]`,
        );
      }
    },
  );

  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ersetzt fehlende/ungültige Messung %s nicht durch Null",
    (sizeBytes) => {
      const text = render({
        footprint:
          sizeBytes === undefined ? undefined : { summary: { status: "complete", sizeBytes } },
      });
      expect(text).toContain(
        locale === "de" ? "Bekannt belegt: nicht gemessen" : "Known footprint: not measured",
      );
      expect(text).not.toContain("0 B");
    },
  );

  it.each(["prefixUnavailable", "shaderUnavailable", "trashUnavailable"] as const)(
    "zeigt jede einzelne Blockade %s",
    (area) => {
      const labels = {
        prefixUnavailable: locale === "de" ? "Wine-Prefixe" : "Wine-Prefixes",
        shaderUnavailable: locale === "de" ? "Shadercache" : "shader cache",
        trashUnavailable: locale === "de" ? "Papierkorb" : "trash",
      };
      const lines = render({ cleanup: { [area]: true } }).split("\n");
      const prefix = locale === "de" ? "Bereinigung blockiert:" : "Cleanup blocked:";
      expect(lines.filter((line) => line.startsWith(prefix))).toEqual([
        `${prefix} ${labels[area]} [${locale === "de" ? "vorhandener Anzeigestand" : "existing displayed state"}]`,
      ]);
      expect(lines).not.toContain(
        locale === "de" ? "Bereinigungsfreigabe: unbekannt" : "Cleanup clearance: unknown",
      );
    },
  );

  it.each(["scanning", "trashScanning"] as const)(
    "bewahrt alle Cleanup-Beobachtungen bei %s",
    (scanning) => {
      const lines = render({
        cleanup: {
          [scanning]: true,
          prefixUnavailable: true,
          shaderUnavailable: true,
          trashUnavailable: true,
          incompleteDeletionsCount: 3,
          incompleteDeletionsUnreadable: true,
        },
      }).split("\n");
      const start = lines.findIndex((line) => line.startsWith("Cleanup:"));
      expect(lines.slice(start, start + 8)).toEqual(
        locale === "de"
          ? [
              "Cleanup: vorhandener Anzeigestand, Aktualität unbekannt",
              "Cleanup: Prüfung läuft",
              "Bereinigung blockiert: Wine-Prefixe [vorhandener Anzeigestand]",
              "Bereinigung blockiert: Shadercache [vorhandener Anzeigestand]",
              "Bereinigung blockiert: Papierkorb [vorhandener Anzeigestand]",
              "Abgebrochene Löschung: 3 [vorhandener Anzeigestand]",
              "Claim-Prüfung: unvollständig",
              "",
            ]
          : [
              "Cleanup: existing displayed state, freshness unknown",
              "Cleanup: check in progress",
              "Cleanup blocked: Wine-Prefixes [existing displayed state]",
              "Cleanup blocked: shader cache [existing displayed state]",
              "Cleanup blocked: trash [existing displayed state]",
              "Incomplete deletion: 3 [existing displayed state]",
              "Claim check: incomplete",
              "",
            ],
      );
    },
  );

  it.each([undefined, 0, -1, Number.NaN])(
    "behauptet bei Claim-Anzahl %s keine Abwesenheit oder Freigabe",
    (count) => {
      const text = render({
        cleanup: { incompleteDeletionsCount: count, incompleteDeletionsUnreadable: true },
      });
      expect(text).toContain(
        locale === "de" ? "Abgebrochene Löschung: unbekannt" : "Incomplete deletion: unknown",
      );
      expect(text).toContain(
        locale === "de" ? "Claim-Prüfung: unvollständig" : "Claim check: incomplete",
      );
      expect(text).toContain(
        locale === "de" ? "Bereinigungsfreigabe: unbekannt" : "Cleanup clearance: unknown",
      );
    },
  );

  it.each([true, false])(
    "bewahrt den externen Compatdata-Hinweis bei lesbarer Config %s",
    (readable) => {
      const text = render({
        game: game({ launchOptions: "STEAM_COMPAT_DATA_PATH=/private/prefix %command%" }),
        result: result({ launchConfigStatus: readable ? "available" : "unreadable" }),
      });
      expect(text).toContain(
        locale === "de"
          ? `Externer Compatdata-Hinweis: ${readable ? "vorhanden" : "unbekannt"} [Startoptionen]`
          : `External compatdata hint: ${readable ? "detected" : "unknown"} [launch options]`,
      );
      expect(text).not.toContain("/private/prefix");
      expect(text).not.toContain("STEAM_COMPAT_DATA_PATH");
    },
  );
});
