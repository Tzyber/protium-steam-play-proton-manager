import { describe, expect, it } from "vitest";
import { joinPath, paths, SYSTEM_COMPAT_DIRS } from "../../src/core/paths.js";

describe("paths", () => {
  it("konstruiert Environment-Pfade ohne eigene Discovery", () => {
    expect(paths.libraryFoldersVdf("/home/u/.steam")).toBe(
      "/home/u/.steam/steamapps/libraryfolders.vdf",
    );
    expect(paths.libraryCacheAppDir("/home/u/.steam", 42)).toBe(
      "/home/u/.steam/appcache/librarycache/42",
    );
  });

  it("baut Tool-Verzeichnis und Cover-Kandidat als Fabriken (K-04)", () => {
    // vorher baute die UI den Tool-Pfad per joinPath, cover.ts den Kandidaten
    // selbst (INV-4). beide Pfade kommen jetzt aus paths.ts.
    expect(paths.compatToolDir("/home/u/.steam", "GE-Proton9-27")).toBe(
      "/home/u/.steam/compatibilitytools.d/GE-Proton9-27",
    );
    expect(() => paths.compatToolDir("/home/u/.steam", "../.ssh")).toThrow('".." segment rejected');
    expect(
      paths.libraryCacheHeader(paths.libraryCacheAppDir("/home/u/.steam", 42), "abc123hash"),
    ).toBe("/home/u/.steam/appcache/librarycache/42/abc123hash/library_header.jpg");
  });

  it("lehnt Pfadtraversal in joinPath ab", () => {
    expect(() => joinPath("/home/u", "../.ssh")).toThrow('".." segment rejected');
    expect(() => joinPath("/home/u/.steam", "steamapps", "..", "..")).toThrow(
      '".." segment rejected',
    );
  });

  it("behält eine wurzel aus nur einem schrägstrich", () => {
    // `.filter(Boolean)` hat den fall vorher still zu einem relativen pfad
    // gemacht: aus "/" + "steamapps" wurde "steamapps".
    expect(joinPath("/", "steamapps", "common")).toBe("/steamapps/common");
  });

  it("lehnt eine leere oder relative wurzel ab", () => {
    expect(() => joinPath("", "steamapps")).toThrow("absolute path");
    expect(() => joinPath("relative/root", "steamapps")).toThrow("absolute path");
  });

  it("normalisiert doppelte und abschließende trenner", () => {
    expect(joinPath("/home/u/.steam/", "config", "config.vdf")).toBe(
      "/home/u/.steam/config/config.vdf",
    );
    expect(joinPath("/home/u/.steam", "steamapps/", "libraryfolders.vdf")).toBe(
      "/home/u/.steam/steamapps/libraryfolders.vdf",
    );
  });

  it("führt nur die beiden festen System-Compat-Wurzeln", () => {
    expect(SYSTEM_COMPAT_DIRS).toEqual([
      "/usr/share/steam/compatibilitytools.d",
      "/usr/local/share/steam/compatibilitytools.d",
    ]);
  });
});

describe("joinPath (path-traversal-rejection)", () => {
  it("verbietet .. in segmenten", () => {
    expect(() => joinPath("/home", "..", "etc")).toThrow("..");
  });

  it("verbietet .. am anfang", () => {
    expect(() => joinPath("/foo", "..")).toThrow("..");
  });

  it("verbietet .. in mehrteiligem segment", () => {
    expect(() => joinPath("/a/b", "c/../../etc")).toThrow("..");
  });

  it("erlaubt normale pfade", () => {
    expect(joinPath("/home/u", ".local", "share")).toBe("/home/u/.local/share");
  });

  it("erlaubt externe mount-pfade", () => {
    expect(joinPath("/run/media/user", "SteamLibrary")).toBe("/run/media/user/SteamLibrary");
    expect(joinPath("/mnt", "games")).toBe("/mnt/games");
  });
});
