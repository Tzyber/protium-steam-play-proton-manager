import { describe, expect, it } from "vitest";
import { BLOCKLIST } from "../../src/core/blocklist.js";
import { projectSupportFacts } from "../../src/core/support.js";
import type { CompatTool, Game, ScanResult } from "../../src/core/types.js";

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
    libraries: ["/steam/library", "/steam/other-library"],
    games: [],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: null,
    compatConfigStatus: "available",
    steamUserId: "76561198012345678",
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

describe("projectSupportFacts", () => {
  it("projiziert erlaubte Fakten für ein explizit zugeordnetes Custom-Tool", () => {
    const currentGame = game({
      launchOptions: "STEAM_COMPAT_DATA_PATH=/home/private/prefix %command%",
    });
    const scan = result({
      games: [currentGame],
      compatToolsInstalled: [customTool("directory-name", "proton_experimental")],
    });

    expect(
      projectSupportFacts({
        game: currentGame,
        result: scan,
        footprint: { summary: { status: "complete", sizeBytes: 4096 } },
        cleanup: {
          scanning: false,
          trashScanning: false,
          prefixUnavailable: false,
          shaderUnavailable: false,
          trashUnavailable: false,
          incompleteDeletionsCount: 0,
          incompleteDeletionsUnreadable: false,
        },
      }),
    ).toEqual({
      appId: 620,
      library: "<steam-library-1>",
      scanCoverage: "complete",
      compatConfigStatus: "available",
      launchConfigStatus: "available",
      compatToolSource: "explicit",
      compatToolAlias: "Proton Experimental",
      compatToolAvailability: "available",
      protonDbTier: "gold",
      footprint: { status: "complete", sizeBytes: 4096 },
      externalCompatdata: "detected",
      cleanup: {
        scanInProgress: false,
        prefixUnavailable: false,
        shaderUnavailable: false,
        trashUnavailable: false,
        incompleteDeletionsCount: 0,
        incompleteDeletionsUnreadable: false,
      },
    });
  });

  it("verwendet beim globalen Standard das Default-Tool und dessen Inventar", () => {
    const currentGame = game({ compatTool: "default", compatToolSource: "default" });
    const scan = result({
      games: [currentGame],
      defaultCompatTool: "proton_experimental",
      compatToolsInstalled: [customTool("directory-name", "proton_experimental")],
    });

    expect(projectSupportFacts({ game: currentGame, result: scan })).toMatchObject({
      compatToolSource: "default",
      compatToolAlias: "Proton Experimental",
      compatToolAvailability: "available",
    });
  });

  it("gibt bei fehlender oder unlesbarer Config weder alten Alias noch Toolstatus aus", () => {
    const currentGame = game({ compatTool: "old-private-tool", compatToolSource: "explicit" });
    const scan = result({
      games: [currentGame],
      compatConfigStatus: "unreadable",
      compatToolsInstalled: [customTool("old-private-tool")],
    });

    expect(projectSupportFacts({ game: currentGame, result: scan })).toMatchObject({
      compatConfigStatus: "unreadable",
      compatToolSource: "unavailable",
      compatToolAlias: null,
      compatToolAvailability: "unknown",
    });
  });

  it.each([
    ["explizit nicht erkannt", "explicit", "missing-tool", "not-recognized", false],
    ["explizit bei unlesbarem Tool-Scan unbekannt", "explicit", "missing-tool", "unknown", true],
    ["globaler Standard ohne Inventarbeleg unbekannt", "default", "missing-tool", "unknown", false],
  ] as const)("trennt Toolstatus: %s", (_label, source, toolName, expected, unreadable) => {
    const currentGame = game({
      compatTool: source === "default" ? "default" : toolName,
      compatToolSource: source,
    });
    const scan = result({
      games: [currentGame],
      defaultCompatTool: source === "default" ? toolName : null,
      warnings: unreadable
        ? [{ type: "compat-tool", directory: "/steam/tools", reason: "directory-unreadable" }]
        : [],
    });

    expect(projectSupportFacts({ game: currentGame, result: scan }).compatToolAvailability).toBe(
      expected,
    );
  });

  it("erkennt ein Builtin nur über dessen internalName", () => {
    const currentGame = game({ compatTool: "proton_experimental" });
    const scan = result({
      games: [currentGame],
      builtinProtonsInstalled: [
        { internalName: "proton_experimental", displayName: "Proton Experimental" },
      ],
    });

    expect(projectSupportFacts({ game: currentGame, result: scan }).compatToolAvailability).toBe(
      "available",
    );
  });

  it("begrenzt Library auf exakten ersten Match und lässt fehlende Pfade unbekannt", () => {
    const currentGame = game({ library: "/not-in-scan" });
    const scan = result({ games: [currentGame] });
    expect(projectSupportFacts({ game: currentGame, result: scan }).library).toBeNull();

    const duplicateScan = result({ libraries: ["/steam/library", "/steam/library"] });
    expect(projectSupportFacts({ game: game(), result: duplicateScan }).library).toBe(
      "<steam-library-1>",
    );
  });

  it("validiert AppID, Tier und Footprint statt ungültige Zahlen zu exportieren", () => {
    const currentGame = game({
      appId: Number.MAX_SAFE_INTEGER,
    });
    currentGame.protonDb = {
      tier: "not-a-tier",
      confidence: "fixture",
    } as unknown as NonNullable<Game["protonDb"]>;
    const scan = result({ games: [currentGame] });
    const facts = projectSupportFacts({
      game: currentGame,
      result: scan,
      footprint: { summary: { status: "complete", sizeBytes: Number.MAX_SAFE_INTEGER + 1 } },
    });

    expect(facts.appId).toBeNull();
    expect(facts.protonDbTier).toBe("unknown");
    expect(facts.footprint).toEqual({ status: "not-measured" });
  });

  it.each([
    ["fehlend", undefined],
    ["nicht gemessen", { status: "not-measured" }],
    ["fehlerhafte Größe", { status: "partial", sizeBytes: -1 }],
  ] as const)("behandelt Footprint %s als nicht gemessen", (_label, summary) => {
    const currentGame = game();
    const facts = projectSupportFacts({
      game: currentGame,
      result: result({ games: [currentGame] }),
      footprint: summary === undefined ? undefined : { summary },
    });
    expect(facts.footprint).toEqual({ status: "not-measured" });
  });

  it("verwendet Game.sizeBytes nie als Mess-Fallback", () => {
    const currentGame = game({ sizeBytes: 987654 });
    const facts = projectSupportFacts({
      game: currentGame,
      result: result({ games: [currentGame] }),
    });
    expect(facts.footprint).toEqual({ status: "not-measured" });
  });

  it("bewahrt positive Cleanup-Beobachtungen, markiert laufende Prüfung und validiert Claims", () => {
    const currentGame = game();
    const facts = projectSupportFacts({
      game: currentGame,
      result: result({ games: [currentGame] }),
      cleanup: {
        scanning: true,
        trashScanning: false,
        prefixUnavailable: true,
        shaderUnavailable: false,
        trashUnavailable: true,
        incompleteDeletionsCount: 3,
        incompleteDeletionsUnreadable: true,
      },
    });

    expect(facts.cleanup).toEqual({
      scanInProgress: true,
      prefixUnavailable: true,
      shaderUnavailable: false,
      trashUnavailable: true,
      incompleteDeletionsCount: 3,
      incompleteDeletionsUnreadable: true,
    });
  });

  it("verwirft unvalidierte Claim-Zahlen und gibt keine Cleanup-Pfade weiter", () => {
    const currentGame = game();
    const facts = projectSupportFacts({
      game: currentGame,
      result: result({ games: [currentGame], steamRoot: "/home/fixture-private-user/.steam" }),
      cleanup: { incompleteDeletionsCount: Number.NaN },
    });

    expect(facts.cleanup.incompleteDeletionsCount).toBeNull();
    expect(JSON.stringify(facts)).not.toContain("fixture-private-user");
  });

  it("führt die vollständige Privacy-Projektion ohne untrusted Freitext aus", () => {
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
      defaultCompatTool: marker,
      skippedLibraries: [{ path: `${privatePath}/missing`, reason: "read-failed" }],
      cleanupUnsafeLibraries: [`${privatePath}/unsafe`],
      warnings: [
        {
          type: "manifest",
          library: marker,
          manifestName: marker,
          appId: 620,
          reason: "invalid-content",
          detail: marker,
        },
        {
          type: "compat-tool",
          directory: privatePath,
          toolName: marker,
          reason: "vdf-invalid",
          detail: marker,
        },
      ],
    });
    const facts = projectSupportFacts({
      game: currentGame,
      result: scan,
      footprint: { summary: { status: "partial", sizeBytes: 1024 } },
      cleanup: {
        prefixUnavailable: true,
        incompleteDeletionsCount: 2,
        incompleteDeletionsUnreadable: true,
      },
    });

    expect(JSON.stringify(facts)).not.toContain(marker);
    expect(JSON.stringify(facts)).not.toContain(privatePath);
    expect(facts.appId).toBe(620);
    expect(facts.library).toBe("<steam-library-1>");
    expect(facts.compatToolAlias).toBe("<compat-tool-1>");
  });
});

describe.each(["explicit", "default"] as const)("Toolnamen-Freigabe bei %s", (source) => {
  function project(name: string, overrides: Partial<ScanResult> = {}) {
    const currentGame = game({
      compatToolSource: source,
      compatTool: source === "explicit" ? name : "proton_hotfix",
    });
    return projectSupportFacts({
      game: currentGame,
      result: result({
        games: [currentGame],
        defaultCompatTool: source === "default" ? name : "GE-Proton9-27",
        ...overrides,
      }),
    });
  }

  it.each([
    "my-custom-proton",
    "GE-Proton",
    "GE-Proton10",
    "GE-Proton10-12-foo",
    "../etc/passwd",
    "/home/fixture-private-user/GE-Proton10-12",
    "GE-Proton10-12-fixture-private-user",
    "private-GE-Proton10-12",
    " GE-Proton10-12",
    "GE-Proton10-12 ",
    "GE-Proton10-12\t",
    "GE-Proton10-12\n",
    "GE-Proton10-12\r",
    "GE-Proton10-12\r\n",
    "GE-Proton10-12\u2028",
    "GE-Proton10-12\u2029",
    "GE-Proton10-12\0",
    "GE-Proton１０-12",
    "ge-Proton10-12",
    "GE-Proton10-12-X86_64",
    " proton_experimental",
    "proton_experimental\n",
    "Proton_Experimental",
  ])("aliasiert den nicht freigegebenen Namen %j", (name) => {
    expect(project(name).compatToolAlias).toBe("<compat-tool-1>");
  });

  it("verwendet weder Anzeigenamen noch Verzeichnisnamen als Ersatzquelle", () => {
    expect(
      project("private-tool", {
        compatToolsInstalled: [
          { ...customTool("GE-Proton10-12", "private-tool"), displayName: "Proton Experimental" },
        ],
      }),
    ).toMatchObject({ compatToolAlias: "<compat-tool-1>", compatToolAvailability: "available" });
  });

  it.each(["missing", "unreadable", undefined] as const)(
    "unterdrückt alte freigegebene Namen bei Configstatus %s",
    (compatConfigStatus) => {
      expect(project("proton_experimental", { compatConfigStatus })).toMatchObject({
        compatToolSource: "unavailable",
        compatToolAlias: null,
        compatToolAvailability: "unknown",
      });
    },
  );

  it.each(["", "default", "unknown"])("bewahrt unbekannte Zuordnung für %j", (name) => {
    expect(project(name)).toMatchObject({
      compatToolSource: source === "default" ? "unavailable" : "explicit",
      compatToolAlias: null,
      compatToolAvailability: "unknown",
    });
  });

  it("liefert für jeden unterschiedlichen Valve-Namen das erste feste Label", () => {
    const checked = new Set<string>();
    for (const entry of BLOCKLIST) {
      if (entry.category !== "proton-builtin" || !entry.toolName || checked.has(entry.toolName)) {
        continue;
      }
      checked.add(entry.toolName);
      expect(project(entry.toolName).compatToolAlias).toBe(entry.label);
    }
    expect(checked.size).toBeGreaterThan(0);
  });

  it("leitet aus proton_11 keine ARM64-Architektur ab", () => {
    expect(project("proton_11").compatToolAlias).toBe("Proton 11.0");
  });

  it("gibt Runtime- und Redistributable-Labels nicht als Toolnamen frei", () => {
    for (const entry of BLOCKLIST) {
      if (entry.category === "proton-builtin") continue;
      expect(project(entry.label).compatToolAlias).toBe("<compat-tool-1>");
    }
  });

  it.each([
    "GE-Proton10-12",
    "GE-Proton9-27",
    "GE-Proton10-12-x86_64",
    "GE-Proton11-3-aarch64",
    "GE-Proton76561198012345678-1",
  ])("gibt die Namensform %s ohne Release- oder Herkunftsbeleg frei", (name) => {
    expect(project(name).compatToolAlias).toBe(name);
  });

  it.each([
    ["proton_experimental", "Proton Experimental"],
    ["GE-Proton10-12", "GE-Proton10-12"],
    ["private-tool", "<compat-tool-1>"],
  ])("trennt Namensfreigabe und Inventarstatus für %s", (name, expected) => {
    const installed = {
      compatToolsInstalled: [
        { ...customTool("private-directory", name), displayName: "fixture-private-display" },
      ],
    };
    expect(project(name, installed)).toMatchObject({
      compatToolSource: source,
      compatToolAlias: expected,
      compatToolAvailability: "available",
    });
    expect(project(name)).toMatchObject({
      compatToolAlias: expected,
      compatToolAvailability: source === "explicit" ? "not-recognized" : "unknown",
    });
    expect(
      project(name, {
        warnings: [
          { type: "compat-tool", directory: "/steam/tools", reason: "directory-unreadable" },
        ],
      }),
    ).toMatchObject({ compatToolAlias: expected, compatToolAvailability: "unknown" });
  });
});

it("exportiert bei nicht verfügbarer Quelle keine bekannte alte Zuordnung", () => {
  expect(
    projectSupportFacts({
      game: game({ compatToolSource: "unavailable" }),
      result: result({ defaultCompatTool: "GE-Proton10-12" }),
    }),
  ).toMatchObject({
    compatToolSource: "unavailable",
    compatToolAlias: null,
    compatToolAvailability: "unknown",
  });
});

it.each(["explicit", "default"] as const)("bewahrt fehlende Namen bei %s als null", (source) => {
  const currentGame = game({ compatToolSource: source });
  Reflect.deleteProperty(currentGame, "compatTool");
  expect(
    projectSupportFacts({ game: currentGame, result: result({ defaultCompatTool: null }) }),
  ).toMatchObject({ compatToolAlias: null, compatToolAvailability: "unknown" });
});
