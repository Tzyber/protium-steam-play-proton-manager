import { describe, expect, it } from "vitest";
import * as pathsModule from "../../src/core/paths.js";
import { paths, SYSTEM_COMPAT_DIRS } from "../../src/core/paths.js";
import { readRepoFile, resolveRepoRoot } from "../support/themeTokens";

describe("paths", () => {
  it("konstruiert Environment-Pfade ohne eigene Discovery", () => {
    expect(paths.libraryCacheAppDir("/home/u/.steam", 42)).toBe(
      "/home/u/.steam/appcache/librarycache/42",
    );
  });

  it("baut Tool-Verzeichnis und Cover-Kandidat als Fabriken (K-04)", () => {
    // vorher baute die UI den Tool-Pfad selbst, cover.ts den Kandidaten
    // selbst (INV-4). beide Pfade kommen jetzt aus paths.ts.
    expect(paths.compatToolDir("/home/u/.steam", "GE-Proton9-27")).toBe(
      "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
    );
    expect(() => paths.compatToolDir("/home/u/.steam", "../.ssh")).toThrow('".." segment rejected');
    expect(
      paths.libraryCacheHeader(paths.libraryCacheAppDir("/home/u/.steam", 42), "abc123hash"),
    ).toBe("/home/u/.steam/appcache/librarycache/42/abc123hash/library_header.jpg");
  });

  it("baut einen Eintrag in einem absoluten verzeichnis (entryIn)", () => {
    expect(paths.entryIn("/home/u/.steam/steamapps", "appmanifest_42.acf")).toBe(
      "/home/u/.steam/steamapps/appmanifest_42.acf",
    );
    expect(paths.entryIn("/home/u/.steam/steamapps/", "appmanifest_42.acf")).toBe(
      "/home/u/.steam/steamapps/appmanifest_42.acf",
    );
  });

  it("die drei Wrapper delegieren auf entryIn (2.2/2.3)", () => {
    const dir = "/lib/steamapps";
    const name = "appmanifest_42.acf";
    expect(paths.manifestIn(dir, name)).toBe(paths.entryIn(dir, name));
    expect(paths.claimEntryIn(dir, name)).toBe(paths.entryIn(dir, name));
    expect(paths.trashEntryIn(dir, name)).toBe(paths.entryIn(dir, name));

    const source = readRepoFile("src/core/paths.ts");
    for (const wrapper of ["manifestIn", "claimEntryIn", "trashEntryIn"]) {
      expect(source, `${wrapper} ruft entryIn nicht auf`).toMatch(
        new RegExp(`${wrapper}: \\([^)]*\\) => entryIn\\(`),
      );
    }
  });

  it("führt nur die beiden festen System-Compat-Wurzeln", () => {
    expect(SYSTEM_COMPAT_DIRS).toEqual([
      "/usr/share/steam/compatibilitytools.d",
      "/usr/local/share/steam/compatibilitytools.d",
    ]);
  });
});

describe("paths: entfernte Exporte (1.12, 6.6)", () => {
  it("exportiert joinPath nicht mehr", () => {
    expect("joinPath" in pathsModule).toBe(false);
    // Positivkontrolle: das modul selbst ist erreichbar.
    expect(typeof pathsModule.paths).toBe("object");
  });

  it("führt libraryFoldersVdf nicht mehr als Pfad-Fabrik", () => {
    expect(Object.keys(paths)).not.toContain("libraryFoldersVdf");
    expect(Object.keys(paths)).toContain("entryIn");
  });

  it("setzt LOCAL_HEADER_FILENAME vor das paths-objekt (2.13)", () => {
    const source = readRepoFile("src/core/paths.ts");
    const constant = source.indexOf("const LOCAL_HEADER_FILENAME");
    const object = source.indexOf("export const paths");
    expect(constant).toBeGreaterThanOrEqual(0);
    expect(object).toBeGreaterThan(constant);
  });
});

describe("entryIn (path-traversal-rejection)", () => {
  it("verbietet .. in segmenten", () => {
    expect(() => paths.entryIn("/home", "../etc")).toThrow("..");
  });

  it("verbietet .. als ganzen namen", () => {
    expect(() => paths.entryIn("/foo", "..")).toThrow("..");
  });

  it("verbietet .. in mehrteiligem segment", () => {
    expect(() => paths.entryIn("/a/b", "c/../../etc")).toThrow("..");
  });

  it("behält eine wurzel aus nur einem schrägstrich", () => {
    // `.filter(Boolean)` hat den fall vorher still zu einem relativen pfad
    // gemacht: aus "/" + "steamapps" wurde "steamapps".
    expect(paths.entryIn("/", "steamapps/common")).toBe("/steamapps/common");
  });

  it("lehnt eine leere oder relative wurzel ab", () => {
    expect(() => paths.entryIn("", "steamapps")).toThrow("absolute path");
    expect(() => paths.entryIn("relative/root", "steamapps")).toThrow("absolute path");
  });

  it("normalisiert doppelte und abschließende trenner", () => {
    expect(paths.entryIn("/home/u/.steam/", "config/config.vdf")).toBe(
      "/home/u/.steam/config/config.vdf",
    );
    expect(paths.entryIn("/home/u/.steam", "steamapps/")).toBe("/home/u/.steam/steamapps");
  });

  it("erlaubt normale und externe mount-pfade", () => {
    expect(paths.entryIn("/home/u", ".local/share")).toBe("/home/u/.local/share");
    expect(paths.entryIn("/run/media/user", "SteamLibrary")).toBe("/run/media/user/SteamLibrary");
    expect(paths.entryIn("/mnt", "games")).toBe("/mnt/games");
  });
});

describe("resolveRepoRoot", () => {
  it("löst innerhalb einer Stryker-Sandbox auf das echte Repo-Root auf", () => {
    expect(resolveRepoRoot("/repo/.stryker-tmp/sandbox-123/tests/support")).toBe("/repo");
    expect(resolveRepoRoot("/repo/tests/support")).toBe("/repo");
  });
});
