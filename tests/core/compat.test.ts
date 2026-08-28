import { describe, expect, it, vi } from "vitest";
import { listCompatTools, recomputeToolUsedBy } from "../../src/core/compat.js";
import type {
  DirEntry,
  DirectorySize,
  FileSystem,
  PathIdentity,
  System,
} from "../../src/core/ports.js";

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

  it("weichender verzeichnisname zählt wie in listCompatTools (alt-mappings)", () => {
    const tools = [{ name: "dir-name", internalName: "real-internal", usedBy: [] }];
    const games = [
      { appId: 5, compatTool: "dir-name" },
      { appId: 6, compatTool: "real-internal" },
    ];

    recomputeToolUsedBy(tools, games);

    expect(tools[0]?.usedBy).toEqual([5, 6]);
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
      realpath: vi.fn(async (path: string) => path),
      writeTextFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
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
      realpath: vi.fn(async (p: string) => p),
      writeTextFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
    };

    const pi: PathIdentity = { realpath: "/compat", dev: "1", ino: "1" };

    const system: System = {
      geTargetArch: vi.fn(async () => "x86_64" as const),
      discoverSteamEnvironment: vi.fn(async () => ({
        generation: 1,
        steamRoot: "/fake/steam",
        libraries: ["/fake/steam"],
        systemCompatDirs: [],
        appCacheDir: "/tmp/cache",
        appConfigDir: "/tmp/config",
      })),
      listTrashEntries: vi.fn(async (library: string) => ({
        dir: `${library}/steamapps/.protium-trash`,
        present: false,
        entries: [],
      })),
      isProcessRunning: vi.fn(async () => false),
      dirSize: vi.fn(async () => ({ status: "measured" as const, sizeBytes: 0 })),
      batchDirSizes: vi.fn(async (paths: string[]) =>
        Object.fromEntries(
          paths.map((path) => [path, { status: "measured" as const, sizeBytes: 0 }]),
        ),
      ),
      pathIdentity: vi.fn(async () => pi),
      installGeProton: vi.fn(async () => "verified" as const),
      cancelDownload: vi.fn(async () => {}),
      saveLaunchOptions: vi.fn(async () => "written" as const),
      saveCompatTool: vi.fn(async () => "written" as const),
      prepareDelete: vi.fn(async () => ({
        token: "tok",
        expiresAt: Date.now() + 60000,
        targetType: "compatTool" as const,
        targetPath: "/path",
        consequences: [],
      })),
      executeDelete: vi.fn(async () => ({ success: true, deletedPath: "/path" })),
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

  it("zählt fehlendes tool-verzeichnis nicht als fehler", async () => {
    const fs: FileSystem = {
      exists: vi.fn(async () => false),
      readTextFile: vi.fn(async () => ""),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => []),
      realpath: vi.fn(async (p: string) => p),
      writeTextFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
    };
    const system = { pathIdentity: vi.fn(async () => null) } as unknown as System;

    const result = await listCompatTools(fs, system, "/fake/steam", new Map(), new Set());

    expect(result).toEqual({ tools: [], warnings: [], counts: { read: 0, failed: 0 } });
    expect(system.pathIdentity).not.toHaveBeenCalled();
  });

  it("zählt einen readDir-fehler des tool-verzeichnisses als directory-unreadable", async () => {
    const fs: FileSystem = {
      exists: vi.fn(async () => true),
      readTextFile: vi.fn(async () => ""),
      readFile: vi.fn(async () => new Uint8Array()),
      readDir: vi.fn(async () => {
        throw new Error("directory denied");
      }),
      realpath: vi.fn(async (p: string) => p),
      writeTextFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
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
          'compat-verzeichnis "/fake/steam/compatibilitytools.d" nicht lesbar: directory denied',
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
      realpath: vi.fn(async (p: string) => p),
      writeTextFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
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
      realpath: vi.fn(async (p: string) => p),
      writeTextFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
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
});
