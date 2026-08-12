import { describe, expect, it, vi } from "vitest";
import { listCompatTools, recomputeToolUsedBy } from "../../src/core/compat.js";
import type { DirEntry, FileSystem, PathIdentity, System } from "../../src/core/ports.js";

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
  it("filtert symlink-einträge aus (F-E-03)", async () => {
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
      remove: vi.fn(async () => {}),
      writeTextFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
    };

    const pi: PathIdentity = { realpath: "/compat", dev: "1", ino: "1" };

    const system: System = {
      listTrashEntries: vi.fn(async (library: string) => ({
        dir: `${library}/steamapps/.protium-trash`,
        present: false,
        entries: [],
      })),
      isProcessRunning: vi.fn(async () => false),
      dirSize: vi.fn(async () => 0),
      batchDirSizes: vi.fn(async () => ({})),
      allowLibraryScope: vi.fn(async () => {}),
      pathIdentity: vi.fn(async () => pi),
      downloadFile: vi.fn(async () => "hash"),
      fetchSha512: vi.fn(async () => {
        throw new Error("fetchSha512 not mocked");
      }),
      cancelDownload: vi.fn(async () => {}),
      extractTarball: vi.fn(async () => {}),
      writeSteamConfigFile: vi.fn(async () => {}),
      removeCompatTool: vi.fn(async () => {}),
    };

    const warnings: string[] = [];
    const tools = await listCompatTools(fs, system, "/fake/steam", new Map(), warnings, new Set());

    const names = tools.map((t) => t.name);
    expect(names).toContain("GE-Proton9-27");
    expect(names).not.toContain("evil-link");
    expect(names).not.toContain("not-a-dir");

    // übersprungener symlink muss sichtbar werden, nicht lautlos verschwinden
    expect(warnings.some((w) => w.includes("evil-link") && w.includes("symlink"))).toBe(true);
    // eine gewöhnliche nicht-dir-datei ist kein warnungsfall
    expect(warnings.some((w) => w.includes("not-a-dir"))).toBe(false);
  });
});
