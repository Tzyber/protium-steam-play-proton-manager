import { describe, expect, it, vi } from "vitest";
import { EXTRACT_TEMP_PREFIX, listCompatTools } from "../../src/core/compat.js";
import { recomputeToolUsedBy } from "../../src/core/compatTools.js";
import type {
  DirEntry,
  DirectorySize,
  FileSystem,
  PathIdentity,
  System,
} from "../../src/core/ports.js";

import { MOCK_TOKEN_TTL_MS } from "../support/mockTokenTtl";

describe("recomputeToolUsedBy", () => {
  it("rechnet usedBy aus dem spielstand neu (wechsel + entfernen)", () => {
    const tools = [
      { name: "GE-Proton9-27", internalName: "GE-Proton9-27", usedBy: [42] },
      { name: "GE-Proton10-1", internalName: "GE-Proton10-1", usedBy: [] },
    ];
    const games = [
      { appId: 42, compatTool: "GE-Proton10-1" },
      { appId: 73, compatTool: "GE-Proton10-1" },
      { appId: 99, compatTool: "default" },
    ];

    recomputeToolUsedBy(tools, games);

    expect(tools[0]?.usedBy).toEqual([]);
    expect(tools[1]?.usedBy).toEqual([42, 73]);
  });

  it("zählt nur den internen namen, nicht den abweichenden verzeichnisnamen", () => {
    const tools = [{ name: "dir-name", internalName: "real-internal", usedBy: [] }];
    const games = [
      { appId: 5, compatTool: "dir-name" },
      { appId: 6, compatTool: "real-internal" },
    ];

    recomputeToolUsedBy(tools, games);

    // spiel 5 zeigt auf den verzeichnisnamen: dazu gibt es kein tool, und der
    // library-filter matcht `game.compatTool` gegen den internen namen. würde
    // die zählung ihn mitnehmen, zeigte der proton-manager eine zahl, die die
    // library nach dem klick nicht einlöst (audit U-1).
    expect(tools[0]?.usedBy).toEqual([6]);
  });
});

describe("listCompatTools", () => {
  it("übernimmt nur gemessene verzeichnisgrößen und markiert missing als unbekannt", async () => {
    const entries: DirEntry[] = [
      { name: "measured", isDirectory: true, isSymlink: false },
      { name: "missing", isDirectory: true, isSymlink: false },
    ];
    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readTextFile: vi.fn(async (path: string) => {
        const name = path.includes("measured") ? "measured" : "missing";
        return `"compatibilitytools"
{
  "compat_tools"
  {
    "${name}"
    {
      "display_name" "${name}"
    }
  }
}`;
      }),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => entries),
    };
    const system = {
      pathIdentity: vi.fn(async () => ({ realpath: "/compat", dev: "1", ino: "1" })),
      dirSize: vi.fn(
        async (path: string): Promise<DirectorySize> =>
          path.endsWith("/measured")
            ? { status: "measured", sizeBytes: 12 }
            : { status: "missing" },
      ),
    } as unknown as System;

    const result = await listCompatTools(fs, system, "/fake/steam", new Map(), new Set());

    expect(result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ internalName: "measured", sizeBytes: 12 }),
        expect.objectContaining({ internalName: "missing", sizeBytes: undefined }),
      ]),
    );
    expect(result.warnings).toEqual([
      expect.objectContaining({ toolName: "missing", reason: "size-unreadable" }),
    ]);
  });

  it("filtert symlink-einträge aus", async () => {
    /** fake-DirEntry-array für einen kompat-tools-dir-scan. */
    const entries: DirEntry[] = [
      { name: "GE-Proton9-27", isDirectory: true, isSymlink: false },
      { name: "evil-link", isDirectory: true, isSymlink: true },
      { name: "not-a-dir", isDirectory: false, isSymlink: false },
    ];

    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readTextFile: vi.fn(async (_path: string) => {
        // minimales VDF für jeden eintrag
        return `"compatibilitytools"
       {
         "compat_tools"
         {
           "vdf_version"
           {
             "display_name" "Test"
           }
         }
       }`;
      }),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => entries),
    };

    const pi: PathIdentity = { realpath: "/compat", dev: "1", ino: "1" };

    const system: System = {
      geTargetArch: vi.fn(async () => "x86_64" as const),
      discoverSteamEnvironment: vi.fn(async () => ({
        generation: 1,
        steamRoot: "/fake/steam",
        libraries: ["/fake/steam"],
        unavailableLibraries: [],
        systemCompatDirs: [],
      })),
      listTrashEntries: vi.fn(async (library: string) => ({
        dir: `${library}/steamapps/.protium-trash`,
        present: false,
        entries: [],
      })),
      isSteamRunning: vi.fn(async () => false),
      dirSize: vi.fn(async () => ({ status: "measured" as const, sizeBytes: 0 })),
      batchDirSizes: vi.fn(async (paths: string[]) =>
        Object.fromEntries(
          paths.map((path) => [path, { status: "measured" as const, sizeBytes: 0 }]),
        ),
      ),
      pathIdentity: vi.fn(async () => pi),
      installGeProton: vi.fn(async () => "verified" as const),
      cancelDownload: vi.fn(async () => {}),
      onDownloadProgress: async () => () => {},
      onInstallPhase: async () => () => {},
      saveLaunchOptions: vi.fn(async () => "written" as const),
      saveCompatTool: vi.fn(async () => "written" as const),
      prepareDelete: vi.fn(async () => ({
        token: "tok",
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
        targetType: "compatTool" as const,
        targetPath: "/path",
        consequences: [],
      })),
      executeDelete: vi.fn(async () => ({ deletedPath: "/path" })),
    };

    const result = await listCompatTools(fs, system, "/fake/steam", new Map(), new Set());
    const { tools, warnings } = result;

    const names = tools.map((t) => t.name);
    expect(names).toContain("GE-Proton9-27");
    expect(names).not.toContain("evil-link");
    expect(names).not.toContain("not-a-dir");

    // übersprungener symlink muss sichtbar werden, nicht lautlos verschwinden
    expect(
      warnings.some(
        (w) => w.type === "compat-tool" && w.toolName === "evil-link" && w.reason === "symlink",
      ),
    ).toBe(true);
    // eine gewöhnliche nicht-dir-datei ist kein warnungsfall
    expect(warnings.some((w) => w.type === "compat-tool" && w.toolName === "not-a-dir")).toBe(
      false,
    );
    expect(result.counts).toEqual({ read: 1, failed: 1 });
  });

  it("überspringt ein zweites verzeichnis mit gleicher kanonischer identität", async () => {
    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readTextFile: vi.fn(
        async () => `"compatibilitytools"
{
	"compat_tools"
	{
		"GE-Proton9-27"
		{
			"display_name" "GE"
		}
	}
}`,
      ),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => [{ name: "GE-Proton9-27", isDirectory: true, isSymlink: false }]),
    };
    const system = {
      pathIdentity: vi.fn(async () => ({ realpath: "/compat", dev: "1", ino: "1" })),
      dirSize: vi.fn(async () => ({ status: "measured" as const, sizeBytes: 12 })),
    } as unknown as System;

    // zwei kandidatenpfade (user + system), dieselbe kanonische identität: nur
    // der erste wird gelesen, der zweite ist ein symlink-duplikat.
    const result = await listCompatTools(fs, system, "/library", new Map(), new Set(), ["/system"]);

    expect(system.pathIdentity).toHaveBeenCalledTimes(2);
    expect(fs.readDir).toHaveBeenCalledTimes(1);
    expect(result.tools).toHaveLength(1);
    expect(result.counts).toEqual({ read: 1, failed: 0 });
    expect(result.warnings).toEqual([]);
  });

  it("zählt fehlendes tool-verzeichnis nicht als fehler", async () => {
    const fs: FileSystem = {
      exists: vi.fn(async () => false),
      readTextFile: vi.fn(async () => ""),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => []),
    };
    const system = { pathIdentity: vi.fn(async () => null) } as unknown as System;

    const result = await listCompatTools(fs, system, "/fake/steam", new Map(), new Set());

    expect(result).toEqual({ tools: [], warnings: [], counts: { read: 0, failed: 0 } });
    expect(system.pathIdentity).not.toHaveBeenCalled();
  });

  it("behandelt erwartetes pathIdentity-null direkt als warnung (K-10)", async () => {
    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readTextFile: vi.fn(async () => ""),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => []),
    };
    // ports.ts:82 definiert `null` als erwarteten zustand. der detailltext kommt
    // aus dem fail-pfad, nicht aus einer selbst gefangenen exception.
    const system = { pathIdentity: vi.fn(async () => null) } as unknown as System;

    const result = await listCompatTools(fs, system, "/fake/steam", new Map(), new Set());

    expect(result.counts).toEqual({ read: 0, failed: 1 });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        type: "compat-tool",
        reason: "path-identity",
        detail: "path identity unavailable",
      }),
    ]);
  });

  it("zählt einen readDir-fehler des tool-verzeichnisses als directory-unreadable", async () => {
    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readTextFile: vi.fn(async () => ""),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => {
        throw new Error("directory denied");
      }),
    };
    const system = {
      pathIdentity: vi.fn(async () => ({ realpath: "/compat", dev: "1", ino: "1" })),
    } as unknown as System;

    const result = await listCompatTools(fs, system, "/fake/steam", new Map(), new Set());

    expect(result.counts).toEqual({ read: 0, failed: 1 });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        type: "compat-tool",
        reason: "directory-unreadable",
        detail:
          'compat directory "/fake/steam/compatibilitytools.d" not readable: directory denied',
      }),
    ]);
  });

  it("zählt vollständig geprüfte duplicate-internalName-kandidaten als read", async () => {
    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readTextFile: vi.fn(async (path: string) => {
        const name = path.includes("first") ? "first" : "second";
        return `"compatibilitytools"
{
	"compat_tools"
	{
		"same-internal"
		{
			"display_name" "${name}"
		}
	}
}`;
      }),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => [
        { name: "first", isDirectory: true, isSymlink: false },
        { name: "second", isDirectory: true, isSymlink: false },
      ]),
    };
    const system = {
      pathIdentity: vi.fn(async () => ({ realpath: "/compat", dev: "1", ino: "1" })),
      dirSize: vi.fn(async () => ({ status: "measured" as const, sizeBytes: 12 })),
    } as unknown as System;

    const result = await listCompatTools(fs, system, "/fake/steam", new Map(), new Set());

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.internalName).toBe("same-internal");
    expect(result.counts).toEqual({ read: 2, failed: 0 });
    expect(result.warnings).toEqual([]);
  });

  it("zählt pathIdentity-, directory-, VDF-, size- und symlink-fehler einzeln", async () => {
    const entries: DirEntry[] = [
      { name: "link", isDirectory: true, isSymlink: true },
      { name: "bad-vdf", isDirectory: true, isSymlink: false },
      { name: "bad-size", isDirectory: true, isSymlink: false },
    ];
    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readTextFile: vi.fn(async (path: string) => {
        if (path.includes("bad-vdf")) throw new Error("vdf denied");
        return `"compatibilitytools"
{
	"compat_tools"
	{
		"bad-size"
		{
			"display_name" "Bad Size"
		}
	}
}`;
      }),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => entries),
    };
    let identityCalls = 0;
    const system = {
      pathIdentity: vi.fn(async () => {
        identityCalls += 1;
        if (identityCalls === 1) throw new Error("identity denied");
        return { realpath: "/compat", dev: "1", ino: "1" };
      }),
      dirSize: vi.fn(async () => {
        throw new Error("size denied");
      }),
    } as unknown as System;

    const first = await listCompatTools(fs, system, "/fake/steam", new Map(), new Set());
    expect(first.counts).toEqual({ read: 0, failed: 1 });
    expect(first.warnings).toEqual([
      expect.objectContaining({ type: "compat-tool", reason: "path-identity" }),
    ]);

    const second = await listCompatTools(
      fs,
      { ...system, pathIdentity: vi.fn(async () => ({ realpath: "/compat", dev: "1", ino: "1" })) },
      "/fake/steam",
      new Map(),
      new Set(),
    );
    expect(second.counts).toEqual({ read: 1, failed: 3 });
    expect(second.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "compat-tool", toolName: "link", reason: "symlink" }),
        expect.objectContaining({
          type: "compat-tool",
          toolName: "bad-vdf",
          reason: "vdf-unreadable",
        }),
        expect.objectContaining({
          type: "compat-tool",
          toolName: "bad-size",
          reason: "size-unreadable",
        }),
      ]),
    );
    // bad-size bleibt trotz fehlgeschlagener größenmessung erkannt im inventar
    // (nur die größe ist unbekannt, nie still 0).
    expect(second.tools).toEqual([
      expect.objectContaining({ internalName: "bad-size", sizeBytes: undefined }),
    ]);
  });

  it("zählt bei abweichendem verzeichnisnamen nur den internen namen", async () => {
    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => [{ name: "Folder", isDirectory: true, isSymlink: false }]),
      readTextFile: vi.fn(
        async () => `"compatibilitytools"
{
  "compat_tools"
  {
    "internal"
    {
      "display_name" "Custom Proton"
    }
  }
}`,
      ),
    };
    const system = {
      pathIdentity: vi.fn(async () => ({ realpath: "/compat", dev: "1", ino: "1" })),
      dirSize: vi.fn(async () => ({ status: "measured" as const, sizeBytes: 12 })),
    } as unknown as System;
    // mapping-werte stammen aus config.vdf und nennen den internen namen;
    // "Folder" kann dort nicht stehen, weil spiele-compatTool sonst auf kein
    // installiertes tool zeigt.
    const mapping = new Map([
      [620, "internal"],
      [730, "Folder"],
    ]);

    const result = await listCompatTools(fs, system, "/steam", mapping, new Set([620, 730]));

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe("Folder");
    expect(result.tools[0]?.internalName).toBe("internal");
    expect(result.tools[0]?.usedBy).toEqual([620]);
  });

  it("meldet mehrere compat_tools-einträge als vdf-invalid", async () => {
    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => [{ name: "Folder", isDirectory: true, isSymlink: false }]),
      readTextFile: vi.fn(
        async () => `"compatibilitytools"
{
  "compat_tools"
  {
    "first" {}
    "second" {}
  }
}`,
      ),
    };
    const system = {
      pathIdentity: vi.fn(async () => ({ realpath: "/compat", dev: "1", ino: "1" })),
      dirSize: vi.fn(async () => ({ status: "measured" as const, sizeBytes: 12 })),
    } as unknown as System;

    const result = await listCompatTools(fs, system, "/steam", new Map(), new Set());

    expect(result.tools).toEqual([]);
    expect(result.counts).toEqual({ read: 0, failed: 1 });
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: "compat-tool", toolName: "Folder", reason: "vdf-invalid" }),
    ]);
  });

  it("filtert liegengebliebene extraktionsreste im user-verzeichnis (5.2)", async () => {
    const steamRoot = "/fake/steam";
    const toolsDir = `${steamRoot}/compatibilitytools.d`;
    const tempName = `${EXTRACT_TEMP_PREFIX}4242-a1b2c3`;
    const real: DirEntry = { name: "GE-Proton9-27", isDirectory: true, isSymlink: false };
    const temp: DirEntry = { name: tempName, isDirectory: true, isSymlink: false };

    /** scannt genau die übergebenen einträge im user-verzeichnis. */
    const scan = async (entries: DirEntry[]) => {
      const dirSize = vi.fn(async (_dir: string) => ({
        status: "measured" as const,
        sizeBytes: 12,
      }));
      const fs: FileSystem = {
        exists: vi.fn(async () => true),
        readFile: vi.fn(async () => new Uint8Array()),
        readDir: vi.fn(async () => entries),
        // der interne name ist der verzeichnisname: ein durchgerutschter
        // temp-eintrag wäre damit auch in `tools` sichtbar.
        readTextFile: vi.fn(async (vdfPath: string) => {
          const name = vdfPath.split("/").slice(-2, -1)[0] ?? "";
          return `"compatibilitytools"
{
	"compat_tools"
	{
		"${name}"
		{
			"display_name" "Tool"
		}
	}
}`;
        }),
      };
      const system = {
        pathIdentity: vi.fn(async () => ({ realpath: toolsDir, dev: "1", ino: "1" })),
        dirSize,
      } as unknown as System;

      const result = await listCompatTools(fs, system, steamRoot, new Map(), new Set());
      return { result, dirSize };
    };

    const baseline = await scan([real]);
    const withTemp = await scan([temp, real]);

    // der rest erscheint nicht als tool ...
    expect(baseline.result.tools.map((tool) => tool.name)).toEqual(["GE-Proton9-27"]);
    expect(withTemp.result.tools.map((tool) => tool.name)).toEqual(["GE-Proton9-27"]);
    expect(withTemp.result.tools.some((tool) => tool.name.startsWith(EXTRACT_TEMP_PREFIX))).toBe(
      false,
    );

    // ... verschiebt keinen zähler (kein `read`, kein `failed`) ...
    expect(withTemp.result.counts).toEqual(baseline.result.counts);
    expect(withTemp.result.counts).toEqual({ read: 1, failed: 0 });

    // ... erzeugt keine warnung und wird nicht vermessen.
    expect(withTemp.result.warnings).toEqual([]);
    expect(
      withTemp.result.warnings.some((w) => w.type === "compat-tool" && w.toolName === tempName),
    ).toBe(false);
    expect(withTemp.dirSize.mock.calls.map(([sizePath]) => sizePath)).toEqual([
      `${toolsDir}/GE-Proton9-27`,
    ]);
  });

  it("filtert liegengebliebene extraktionsreste in einem systemCompatDirs-eintrag (5.2)", async () => {
    const steamRoot = "/fake/steam";
    const systemDir = "/usr/share/steam/compatibilitytools.d";
    const tempName = `${EXTRACT_TEMP_PREFIX}777-b0b1`;
    const userTool: DirEntry = { name: "GE-Proton9-27", isDirectory: true, isSymlink: false };
    const systemTool: DirEntry = { name: "GE-Proton10-1", isDirectory: true, isSymlink: false };
    const temp: DirEntry = { name: tempName, isDirectory: true, isSymlink: false };

    /** scannt user-verzeichnis plus einen system-eintrag. */
    const scan = async (systemEntries: DirEntry[]) => {
      const dirSize = vi.fn(async (_dir: string) => ({
        status: "measured" as const,
        sizeBytes: 12,
      }));
      const fs: FileSystem = {
        exists: vi.fn(async () => true),
        readFile: vi.fn(async () => new Uint8Array()),
        readDir: vi.fn(async (dir: string) => (dir === systemDir ? systemEntries : [userTool])),
        readTextFile: vi.fn(async (vdfPath: string) => {
          const name = vdfPath.split("/").slice(-2, -1)[0] ?? "";
          return `"compatibilitytools"
{
	"compat_tools"
	{
		"${name}"
		{
			"display_name" "Tool"
		}
	}
}`;
        }),
      };
      const system = {
        // eigene identität je verzeichnis: sonst greift die symlink-
        // deduplizierung aus readCompatDirEntries und der system-eintrag
        // würde nie gelesen.
        pathIdentity: vi.fn(async (dir: string) => ({ realpath: dir, dev: "1", ino: dir })),
        dirSize,
      } as unknown as System;

      const result = await listCompatTools(fs, system, steamRoot, new Map(), new Set(), [
        systemDir,
      ]);
      return { result, dirSize };
    };

    const baseline = await scan([systemTool]);
    const withTemp = await scan([temp, systemTool]);

    expect(baseline.result.tools.map((tool) => tool.name)).toEqual([
      "GE-Proton9-27",
      "GE-Proton10-1",
    ]);
    expect(withTemp.result.tools.map((tool) => tool.name)).toEqual([
      "GE-Proton9-27",
      "GE-Proton10-1",
    ]);
    expect(withTemp.result.tools.map((tool) => tool.source)).toEqual(["user", "system"]);

    // `read` zählt beide echten tools, der rest bleibt unsichtbar.
    expect(withTemp.result.counts).toEqual(baseline.result.counts);
    expect(withTemp.result.counts).toEqual({ read: 2, failed: 0 });
    expect(withTemp.result.warnings).toEqual([]);
    expect(
      withTemp.result.warnings.some((w) => w.type === "compat-tool" && w.toolName === tempName),
    ).toBe(false);
    expect(
      withTemp.dirSize.mock.calls
        .map(([sizePath]) => sizePath)
        .some((sizePath) => sizePath.includes(EXTRACT_TEMP_PREFIX)),
    ).toBe(false);
  });
});

describe("Zuordnungsanalyse aus vorhandenen Scan-Fakten", () => {
  it("zählt weder globalen Standard noch nicht installierte Spiele und bleibt bei fehlender Config leer", async () => {
    const name = "GE-Proton11-6-x86_64";
    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => [{ name, isDirectory: true, isSymlink: false }]),
      readTextFile: vi.fn(
        async () => `"compatibilitytools"
{
  "compat_tools"
  {
    "${name}"
    {
      "display_name" "GE"
    }
  }
}`,
      ),
    };
    const system = {
      pathIdentity: vi.fn(async () => ({
        realpath: "/library/compatibilitytools.d",
        dev: "1",
        ino: "1",
      })),
      dirSize: vi.fn(async () => ({ status: "measured", sizeBytes: 1024 })),
    } as unknown as System;
    const mapping = new Map([
      [0, name],
      [620, name],
      [999, name],
    ]);
    const installed = new Set([620, 570]);
    const complete = await listCompatTools(fs, system, "/library", mapping, installed);
    expect(complete.tools.map((tool) => tool.usedBy)).toEqual([[620]]);
    const limited = await listCompatTools(fs, system, "/library", new Map(), installed);
    expect(limited.tools.map((tool) => tool.usedBy)).toEqual([[]]);
    const partial = await listCompatTools(fs, system, "/library", mapping, new Set([570]));
    expect(partial.tools.map((tool) => tool.usedBy)).toEqual([[]]);
  });
});
