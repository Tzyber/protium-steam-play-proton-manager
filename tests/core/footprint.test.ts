import { describe, expect, it } from "vitest";
import { type FootprintPart, measureGameFootprint } from "../../src/core/footprint.js";
import { paths } from "../../src/core/paths.js";
import type { DirectorySize, System } from "../../src/core/ports.js";
import type { Game, LaunchConfigStatus } from "../../src/core/types.js";

type BatchResponse = unknown | ((requestedPaths: string[]) => unknown | Promise<unknown>);
type MissingOverrides = {
  compatdata?: { status: "missing" };
  shadercache?: { status: "missing" };
};

function game(overrides: Partial<Game> = {}): Game {
  return {
    appId: 42,
    name: "Game Name",
    library: "/primary/library",
    installdir: "actual-install-dir",
    compatTool: "default",
    compatToolSource: "default",
    protonDb: null,
    localHeader: null,
    headerImage: null,
    ...overrides,
  };
}

function systemWith(response: BatchResponse): Pick<System, "batchDirSizes"> {
  return {
    async batchDirSizes(requestedPaths) {
      const value = typeof response === "function" ? await response(requestedPaths) : response;
      return value as unknown as Record<string, DirectorySize>;
    },
  };
}

function sizes(
  requestedPaths: string[],
  values: Record<string, unknown> = {},
): Record<string, unknown> {
  return Object.fromEntries(
    requestedPaths.map((path, index) => [
      path,
      values[path] ?? { status: "measured", sizeBytes: (index + 1) * 10 },
    ]),
  );
}

function expectedPaths(currentGame: Game): string[] {
  return [
    paths.gameInstallPath(currentGame.library, currentGame.installdir ?? ""),
    paths.compatdataPath(currentGame.library, currentGame.appId),
    paths.shadercachePath(currentGame.library, currentGame.appId),
  ];
}

function part(status: FootprintPart["status"], sizeBytes?: number): FootprintPart {
  return sizeBytes === undefined ? { status } : { status, sizeBytes };
}

describe("paths für Game Footprint", () => {
  it.each([
    ["Haupt-Library", "/primary/library"],
    ["Sekundär-Library", "/mnt/games/SteamLibrary"],
  ])("konstruiert das Installationsziel in der %s", (_label, library) => {
    expect(paths.gameInstallPath(library, "Portal 2")).toBe(`${library}/steamapps/common/Portal 2`);
  });

  it.each([
    ["leer", ""],
    ["punkt", "."],
    ["parent", ".."],
    ["verschachtelt", "Portal/common"],
    ["backslash", "Portal\\common"],
    ["absolut", "/tmp/elsewhere"],
    ["nul", "Portal\0common"],
  ])("lehnt unsicheres installdir (%s) defensiv ab", (_label, installdir) => {
    expect(() => paths.gameInstallPath("/library", installdir)).toThrow(
      "gameInstallPath: unsafe installdir",
    );
  });
});

describe("measureGameFootprint", () => {
  it("fordert im Normalfall exakt die drei erlaubten Ziele an", async () => {
    const currentGame = game({ name: "Name darf kein Pfad sein", installdir: "real-dir" });
    const requested: string[][] = [];
    const result = await measureGameFootprint(
      systemWith((pathsToMeasure: string[]) => {
        requested.push(pathsToMeasure);
        return sizes(pathsToMeasure);
      }),
      currentGame,
      "available",
    );

    expect(requested).toEqual([expectedPaths(currentGame)]);
    expect(requested[0]).not.toContain("Name darf kein Pfad sein");
    expect(result).toEqual({
      gameInstall: part("measured", 10),
      compatdata: part("measured", 20),
      shadercache: part("measured", 30),
      summary: { status: "complete", sizeBytes: 60 },
      externalCompatdata: false,
      compatdataNotChecked: false,
    });
  });

  it.each([
    [
      "nur spieldateien",
      { compatdata: { status: "missing" }, shadercache: { status: "missing" } },
      10,
    ],
    ["spiel plus compatdata", { shadercache: { status: "missing" } }, 30],
    ["spiel plus shader-cache", { compatdata: { status: "missing" } }, 40],
    ["alle drei", {}, 60],
  ] as const)(
    "berechnet die vollständige Summe für %s",
    async (_label: string, overrides: MissingOverrides, expectedSum: number) => {
      const currentGame = game();
      const targetPaths = expectedPaths(currentGame);
      const byName: Record<string, unknown> = {
        [targetPaths[0] ?? ""]: { status: "measured", sizeBytes: 10 },
        [targetPaths[1] ?? ""]: overrides.compatdata ?? { status: "measured", sizeBytes: 20 },
        [targetPaths[2] ?? ""]: overrides.shadercache ?? { status: "measured", sizeBytes: 30 },
      };

      const result = await measureGameFootprint(
        systemWith((requestedPaths: string[]) => sizes(requestedPaths, byName)),
        currentGame,
        "available",
      );

      expect(result.summary).toEqual({ status: "complete", sizeBytes: expectedSum });
      expect(result.compatdata).toEqual(
        overrides.compatdata?.status === "missing" ? part("missing", 0) : part("measured", 20),
      );
      expect(result.shadercache).toEqual(
        overrides.shadercache?.status === "missing" ? part("missing", 0) : part("measured", 30),
      );
    },
  );

  it("setzt missing im Footprint explizit auf 0 B, ohne es unbekannt zu machen", async () => {
    const currentGame = game();
    const targetPaths = expectedPaths(currentGame);
    const result = await measureGameFootprint(
      systemWith((requestedPaths: string[]) =>
        sizes(requestedPaths, {
          [targetPaths[0] ?? ""]: { status: "missing" },
          [targetPaths[1] ?? ""]: { status: "missing" },
          [targetPaths[2] ?? ""]: { status: "missing" },
        }),
      ),
      currentGame,
      "available",
    );

    expect(result.gameInstall).toEqual(part("missing", 0));
    expect(result.compatdata).toEqual(part("missing", 0));
    expect(result.shadercache).toEqual(part("missing", 0));
    expect(result.summary).toEqual({ status: "complete", sizeBytes: 0 });
  });

  it("behandelt ein fehlendes installdir als nicht angeforderten Teilwert", async () => {
    const currentGame = game({ installdir: undefined });
    const requested: string[][] = [];
    const result = await measureGameFootprint(
      systemWith((requestedPaths: string[]) => {
        requested.push(requestedPaths);
        return sizes(requestedPaths);
      }),
      currentGame,
      "available",
    );

    expect(requested).toEqual([
      [
        paths.compatdataPath(currentGame.library, currentGame.appId),
        paths.shadercachePath(currentGame.library, currentGame.appId),
      ],
    ]);
    expect(result.gameInstall).toEqual(part("not-requested"));
    expect(result.summary).toEqual({ status: "partial", sizeBytes: 30 });
  });

  it.each(["", ".", "..", "Dota/common", "Dota\\common", "/outside", "Dota\0common"])(
    "fordert bei unsicherem installdir %j kein Spielziel an",
    async (installdir) => {
      const currentGame = game({ installdir });
      const requested: string[][] = [];
      const result = await measureGameFootprint(
        systemWith((requestedPaths: string[]) => {
          requested.push(requestedPaths);
          return sizes(requestedPaths);
        }),
        currentGame,
        "available",
      );

      expect(requested[0]).toEqual([
        paths.compatdataPath(currentGame.library, currentGame.appId),
        paths.shadercachePath(currentGame.library, currentGame.appId),
      ]);
      expect(result.gameInstall).toEqual(part("not-requested"));
    },
  );

  it.each([
    ["direkte Zuweisung", "  STEAM_COMPAT_DATA_PATH=/secret/user/prefix  "],
    ["env-Zuweisung", "env\tSTEAM_COMPAT_DATA_PATH=/secret/user/prefix %command%"],
  ])("erkennt eine %s, ohne den Wert zu extrahieren", async (_label, launchOptions) => {
    const currentGame = game({ launchOptions });
    const requested: string[][] = [];
    const result = await measureGameFootprint(
      systemWith((requestedPaths: string[]) => {
        requested.push(requestedPaths);
        return sizes(requestedPaths);
      }),
      currentGame,
      "available",
    );

    expect(requested).toEqual([
      [
        paths.gameInstallPath(currentGame.library, currentGame.installdir ?? ""),
        paths.shadercachePath(currentGame.library, currentGame.appId),
      ],
    ]);
    expect(JSON.stringify(result)).not.toContain("/secret/user/prefix");
    expect(result.externalCompatdata).toBe(true);
    expect(result.compatdata).toEqual(part("not-requested"));
    expect(result.summary).toEqual({ status: "partial", sizeBytes: 30 });
  });

  it.each([
    "echo STEAM_COMPAT_DATA_PATH=/secret/user/prefix",
    "XSTEAM_COMPAT_DATA_PATH=/secret/user/prefix",
    "STEAM_COMPAT_DATA_PATHX=/secret/user/prefix",
    "export STEAM_COMPAT_DATA_PATH=/secret/user/prefix",
    "FOO=1 STEAM_COMPAT_DATA_PATH=/secret/user/prefix",
    "env FOO=1 STEAM_COMPAT_DATA_PATH=/secret/user/prefix",
    "env -i STEAM_COMPAT_DATA_PATH=/secret/user/prefix",
  ])("ignoriert nicht direkte Startoptions-Konstruktion: %s", async (launchOptions) => {
    const currentGame = game({ launchOptions });
    const requested: string[][] = [];
    const result = await measureGameFootprint(
      systemWith((requestedPaths: string[]) => {
        requested.push(requestedPaths);
        return sizes(requestedPaths);
      }),
      currentGame,
      "available",
    );

    expect(requested[0]).toEqual(expectedPaths(currentGame));
    expect(result.externalCompatdata).toBe(false);
    expect(result.compatdata.status).toBe("measured");
  });

  it.each(["missing", "unreadable", "ambiguous"] as const)(
    "überspringt compatdata bei launchConfigStatus %s",
    async (launchConfigStatus) => {
      const currentGame = game({ launchOptions: "STEAM_COMPAT_DATA_PATH=/secret" });
      const requested: string[][] = [];
      const result = await measureGameFootprint(
        systemWith((requestedPaths: string[]) => {
          requested.push(requestedPaths);
          return sizes(requestedPaths);
        }),
        currentGame,
        launchConfigStatus,
      );

      expect(requested[0]).toEqual([
        paths.gameInstallPath(currentGame.library, currentGame.installdir ?? ""),
        paths.shadercachePath(currentGame.library, currentGame.appId),
      ]);
      expect(result.externalCompatdata).toBe(false);
      expect(result.compatdataNotChecked).toBe(true);
      expect(result.compatdata).toEqual(part("not-requested"));
      expect(result.summary).toEqual({ status: "partial", sizeBytes: 30 });
      expect(JSON.stringify(result)).not.toContain("/secret");
    },
  );

  it("überspringt compatdata auch bei einem zur Laufzeit unbekannten Launch-Status", async () => {
    const currentGame = game();
    const requested: string[][] = [];
    const result = await measureGameFootprint(
      systemWith((requestedPaths: string[]) => {
        requested.push(requestedPaths);
        return sizes(requestedPaths);
      }),
      currentGame,
      "future-status" as LaunchConfigStatus,
    );

    expect(requested[0]).not.toContain(
      paths.compatdataPath(currentGame.library, currentGame.appId),
    );
    expect(result.compatdataNotChecked).toBe(true);
  });

  it.each([
    ["negativ", -1],
    ["unsicher", Number.MAX_SAFE_INTEGER + 1],
    ["NaN", Number.NaN],
    ["unendlich", Number.POSITIVE_INFINITY],
  ])("markiert unzulässigen measured-Wirewert (%s) als failed", async (_label, badSize) => {
    const currentGame = game();
    const targetPaths = expectedPaths(currentGame);
    const result = await measureGameFootprint(
      systemWith((requestedPaths: string[]) =>
        sizes(requestedPaths, {
          [targetPaths[0] ?? ""]: { status: "measured", sizeBytes: badSize },
          [targetPaths[1] ?? ""]: { status: "measured", sizeBytes: 20 },
          [targetPaths[2] ?? ""]: { status: "missing" },
        }),
      ),
      currentGame,
      "available",
    );

    expect(result.gameInstall).toEqual(part("failed"));
    expect(result.compatdata).toEqual(part("measured", 20));
    expect(result.shadercache).toEqual(part("missing", 0));
    expect(result.summary).toEqual({ status: "partial", sizeBytes: 20 });
  });

  it("markiert unbekannten Status und fehlenden Map-Eintrag als failed", async () => {
    const currentGame = game();
    const targetPaths = expectedPaths(currentGame);
    const result = await measureGameFootprint(
      systemWith({
        [targetPaths[0] ?? ""]: { status: "unknown" },
        [targetPaths[1] ?? ""]: { status: "measured", sizeBytes: 20 },
      }),
      currentGame,
      "available",
    );

    expect(result.gameInstall).toEqual(part("failed"));
    expect(result.compatdata).toEqual(part("measured", 20));
    expect(result.shadercache).toEqual(part("failed"));
    expect(result.summary).toEqual({ status: "partial", sizeBytes: 20 });
  });

  it("markiert eine Ablehnung des gesamten Batches bei allen Zielen als failed", async () => {
    const result = await measureGameFootprint(
      {
        batchDirSizes: async () => {
          throw new Error("backend rejected");
        },
      },
      game(),
      "available",
    );

    expect(result.gameInstall).toEqual(part("failed"));
    expect(result.compatdata).toEqual(part("failed"));
    expect(result.shadercache).toEqual(part("failed"));
    expect(result.summary).toEqual({ status: "not-measured" });
  });

  it.each([null, [], "not-a-map"])(
    "behandelt eine nicht valide Batch-Antwort (%j) fail-closed",
    async (response) => {
      const result = await measureGameFootprint(systemWith(response), game(), "available");
      expect(result.gameInstall).toEqual(part("failed"));
      expect(result.compatdata).toEqual(part("failed"));
      expect(result.shadercache).toEqual(part("failed"));
      expect(result.summary).toEqual({ status: "not-measured" });
    },
  );

  it("verwirft eine Summe bei Safe-Integer-Überlauf", async () => {
    const currentGame = game();
    const targetPaths = expectedPaths(currentGame);
    const result = await measureGameFootprint(
      systemWith({
        [targetPaths[0] ?? ""]: { status: "measured", sizeBytes: Number.MAX_SAFE_INTEGER },
        [targetPaths[1] ?? ""]: { status: "measured", sizeBytes: 1 },
        [targetPaths[2] ?? ""]: { status: "missing" },
      }),
      currentGame,
      "available",
    );

    expect(result.gameInstall).toEqual(part("measured", Number.MAX_SAFE_INTEGER));
    expect(result.compatdata).toEqual(part("measured", 1));
    expect(result.shadercache).toEqual(part("missing", 0));
    expect(result.summary).toEqual({ status: "not-measured" });
  });

  it("zeigt keine Summe, wenn kein Teilwert messbar ist", async () => {
    const currentGame = game();
    const targetPaths = expectedPaths(currentGame);
    const result = await measureGameFootprint(
      systemWith({
        [targetPaths[0] ?? ""]: { status: "failed" },
        [targetPaths[1] ?? ""]: { status: "unknown" },
        [targetPaths[2] ?? ""]: { status: "measured", sizeBytes: -3 },
      }),
      currentGame,
      "available",
    );

    expect(result.summary).toEqual({ status: "not-measured" });
  });
});
