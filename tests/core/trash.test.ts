import { describe, expect, it } from "vitest";
import type { System, TrashListing } from "../../src/core/ports";
import { findTrashEntries } from "../../src/core/trash";

/** minimales System-fake: nur listTrashEntries wird von findTrashEntries genutzt. */
function fakeSystem(impl: (library: string) => Promise<TrashListing>): System {
  return {
    listTrashEntries: impl,
    isProcessRunning: async () => false,
    dirSize: async () => 0,
    batchDirSizes: async () => ({}),
    allowLibraryScope: async () => {},
    pathIdentity: async () => null,
    downloadFile: async () => "",
    cancelDownload: async () => {},
    extractTarball: async () => {},
    writeSteamConfigFile: async () => {},
    removeCompatTool: async () => {},
  };
}

const listing = (dir: string, names: string[]): TrashListing => ({
  dir,
  present: true,
  entries: names.map((name) => ({ name, isDir: true, isSymlink: false })),
});

describe("findTrashEntries", () => {
  it("erkennt gültige compatdata- und shadercache-einträge", async () => {
    const sys = fakeSystem(async () =>
      listing("/lib/steamapps/.protium-trash", [
        "compatdata_1091500_1753372800123",
        "shadercache_42_1753372800999",
      ]),
    );

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]).toMatchObject({
      appId: 1091500,
      type: "compatdata",
      trashedAt: 1753372800123,
      path: "/lib/steamapps/.protium-trash/compatdata_1091500_1753372800123",
    });
    expect(r.unknown).toHaveLength(0);
    expect(r.unreadable).toHaveLength(0);
  });

  it("baut den pfad aus dem verzeichnis des backends, nicht aus dem library-argument", async () => {
    // library kommt aus libraryfolders.vdf und kann ein symlink sein; rust liefert
    // den kanonischen ort zurück. würden wir selbst joinen, zeigte die UI (und das
    // löschen) auf den falschen pfad.
    const sys = fakeSystem(async () =>
      listing("/mnt/real/SteamLibrary/steamapps/.protium-trash", ["compatdata_7_1000"]),
    );

    const r = await findTrashEntries(["/home/u/link-to-lib"], sys);

    expect(r.entries[0]?.path).toBe(
      "/mnt/real/SteamLibrary/steamapps/.protium-trash/compatdata_7_1000",
    );
  });

  it("kein papierkorb ist kein fehler, wird aber pro library gemeldet", async () => {
    const sys = fakeSystem(async () => ({
      dir: "/lib/steamapps/.protium-trash",
      present: false,
      entries: [],
    }));

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries).toHaveLength(0);
    expect(r.unreadable).toHaveLength(0);
    expect(r.libraries).toEqual([
      { library: "/lib", dir: "/lib/steamapps/.protium-trash", present: false, count: 0 },
    ]);
  });

  it("lesefehler wird gemeldet statt als leerer papierkorb behandelt", async () => {
    const sys = fakeSystem(async () => {
      throw new Error("EACCES: permission denied");
    });

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries).toHaveLength(0);
    expect(r.unreadable).toEqual(["/lib"]);
    expect(r.libraries[0]?.error).toContain("EACCES");
  });

  it("ein defekter library-eintrag stoppt die anderen nicht", async () => {
    const sys = fakeSystem(async (lib) => {
      if (lib === "/broken") throw new Error("EIO");
      return listing("/lib/steamapps/.protium-trash", ["compatdata_5_1000"]);
    });

    const r = await findTrashEntries(["/broken", "/lib"], sys);

    expect(r.unreadable).toEqual(["/broken"]);
    expect(r.entries).toHaveLength(1);
    expect(r.libraries).toHaveLength(2);
  });

  it("zählt einträge pro library getrennt", async () => {
    const sys = fakeSystem(async (lib) =>
      lib === "/a"
        ? listing("/a/steamapps/.protium-trash", ["compatdata_1_1000"])
        : listing("/b/steamapps/.protium-trash", ["compatdata_2_1000", "compatdata_3_1000"]),
    );

    const r = await findTrashEntries(["/a", "/b"], sys);

    expect(r.libraries.map((l) => l.count)).toEqual([1, 2]);
    expect(r.entries).toHaveLength(3);
  });

  it("symlink, datei und fremde namen landen in unknown", async () => {
    const sys = fakeSystem(async () => ({
      dir: "/lib/steamapps/.protium-trash",
      present: true,
      entries: [
        { name: "compatdata_9_1000", isDir: true, isSymlink: true },
        { name: "compatdata_8_1000", isDir: false, isSymlink: false },
        { name: "irgendwas", isDir: true, isSymlink: false },
        { name: "compatdata_1091500", isDir: true, isSymlink: false },
        { name: "compatdata_0_1000", isDir: true, isSymlink: false },
      ],
    }));

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries).toHaveLength(0);
    expect(r.unknown).toHaveLength(5);
  });

  it("parseInt-overflow im namen → unknown statt riesen-appId (M4.1)", async () => {
    const sys = fakeSystem(async () =>
      listing("/lib/steamapps/.protium-trash", [`compatdata_${"9".repeat(254)}_1700000000000`]),
    );

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries).toEqual([]);
    expect(r.unknown).toHaveLength(1);
  });

  it("zwei libraries mit identischem papierkorb-pfad: statuszeile für beide, einträge nur einmal", async () => {
    const sys = fakeSystem(async () =>
      listing("/real/steamapps/.protium-trash", ["compatdata_4_1000"]),
    );

    const r = await findTrashEntries(["/link", "/real"], sys);

    expect(r.entries).toHaveLength(1);
    expect(r.libraries).toHaveLength(2);
    expect(r.libraries[0]).toMatchObject({ library: "/link" });
    expect(r.libraries[0]?.duplicateOf).toBeUndefined();
    expect(r.libraries[1]).toMatchObject({ library: "/real", duplicateOf: "/link" });
    expect(r.libraries[0]?.count).toBe(1);
    expect(r.libraries[1]?.count).toBe(0);
  });
});
