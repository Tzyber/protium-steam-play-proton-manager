import { describe, expect, it } from "vitest";
import type { System, TrashListing } from "../../src/core/ports";
import { findTrashEntries } from "../../src/core/trash";

/** minimales System-fake: nur listTrashEntries wird von findTrashEntries genutzt. */
function fakeSystem(impl: (library: string) => Promise<TrashListing>): System {
  return {
    geTargetArch: async () => "x86_64" as const,
    discoverSteamEnvironment: async () => ({
      generation: 1,
      steamRoot: "/tmp/steam",
      libraries: ["/tmp/steam"],
      systemCompatDirs: [],
      appCacheDir: "/tmp/cache",
      appConfigDir: "/tmp/config",
    }),
    listTrashEntries: impl,
    isProcessRunning: async () => false,
    dirSize: async () => ({ status: "measured" as const, sizeBytes: 0 }),
    batchDirSizes: async () => ({}),
    pathIdentity: async () => null,
    installGeProton: async () => "verified" as const,
    cancelDownload: async () => {},
    saveLaunchOptions: async () => "written" as const,
    saveCompatTool: async () => "written" as const,
    prepareDelete: async (req) => ({
      token: "tok",
      expiresAt: Date.now() + 60000,
      targetType: req.targetType,
      targetPath: req.path,
      consequences: [],
    }),
    executeDelete: async () => ({ success: true, deletedPath: "" }),
  };
}

const listing = (dir: string, names: string[]): TrashListing => ({
  dir,
  present: true,
  entries: names.map((name) => ({ name, isDirectory: true, isSymlink: false })),
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
        { name: "compatdata_9_1000", isDirectory: true, isSymlink: true },
        { name: "compatdata_8_1000", isDirectory: false, isSymlink: false },
        { name: "irgendwas", isDirectory: true, isSymlink: false },
        { name: "compatdata_1091500", isDirectory: true, isSymlink: false },
        { name: "compatdata_0_1000", isDirectory: true, isSymlink: false },
      ],
    }));

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries).toHaveLength(0);
    expect(r.unknown).toHaveLength(5);
  });

  it("parseInt-overflow im namen → unknown statt riesen-appId", async () => {
    const sys = fakeSystem(async () =>
      listing("/lib/steamapps/.protium-trash", [`compatdata_${"9".repeat(254)}_1700000000000`]),
    );

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries).toEqual([]);
    expect(r.unknown).toHaveLength(1);
  });

  it("akzeptiert bis u32::MAX (inkl. shortcut-bereich), aber keine größere AppID", async () => {
    const sys = fakeSystem(async () =>
      listing("/lib/steamapps/.protium-trash", [
        "compatdata_2147483647_1700000000000",
        "compatdata_4294967295_1700000000000",
        "compatdata_4294967296_1700000000000",
        "compatdata_999999999999999999999999_1700000000000",
      ]),
    );

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries.map((entry) => entry.appId)).toEqual([2147483647, 4294967295]);
    expect(r.unknown).toHaveLength(2);
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

  it("present-flag ist true wenn papierkorb vorhanden und einträge hat (142:60)", async () => {
    const sys = fakeSystem(async () =>
      listing("/lib/steamapps/.protium-trash", ["compatdata_570_1000000000000"]),
    );

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.libraries[0]?.present).toBe(true);
    expect(r.libraries[0]?.count).toBeGreaterThan(0);
  });

  it("present-flag ist true bei lesefehler (74:53) — fehler != leerer papierkorb", async () => {
    const sys = fakeSystem(async () => {
      throw new Error("EACCES: permission denied");
    });

    const r = await findTrashEntries(["/lib"], sys);

    // present=true: das verzeichnis existiert, konnte aber nicht gelesen werden
    expect(r.libraries[0]?.present).toBe(true);
    expect(r.libraries[0]?.error).toBeDefined();
    expect(r.unreadable).toContain("/lib");
  });

  it("zeitstempel 0 → unknown (M4.1-kommentar: 0 ist nie gültig) (121:60)", async () => {
    const sys = fakeSystem(async () => ({
      dir: "/lib/steamapps/.protium-trash",
      present: true,
      entries: [{ name: "compatdata_570_0", isDirectory: true, isSymlink: false }],
    }));

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries).toHaveLength(0);
    expect(r.unknown).toHaveLength(1);
    expect(r.unknown[0]).toContain("compatdata_570_0");
  });

  it("unsicherer, aber endlicher zeitstempel → unknown", async () => {
    const sys = fakeSystem(async () => ({
      dir: "/lib/steamapps/.protium-trash",
      present: true,
      entries: [{ name: "compatdata_570_9007199254740992", isDirectory: true, isSymlink: false }],
    }));

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries).toHaveLength(0);
    expect(r.unknown).toHaveLength(1);
    expect(r.unknown[0]).toContain("compatdata_570_9007199254740992");
  });

  it("vollständig verankerte regex: präfix und suffix werden abgelehnt (51:23)", async () => {
    // xcompatdata_1_2 hat ein präfix → kein match
    // compatdata_1_2junk hat ein suffix → kein match
    const sys = fakeSystem(async () => ({
      dir: "/lib/steamapps/.protium-trash",
      present: true,
      entries: [
        { name: "xcompatdata_1_2000000000000", isDirectory: true, isSymlink: false },
        { name: "compatdata_1_2000000000000junk", isDirectory: true, isSymlink: false },
      ],
    }));

    const r = await findTrashEntries(["/lib"], sys);

    expect(r.entries).toHaveLength(0);
    expect(r.unknown).toHaveLength(2);
  });
});
