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

  it("lehnt Pfadtraversal in joinPath ab", () => {
    expect(() => joinPath("/home/u", "../.ssh")).toThrow('".." segment rejected');
  });

  it("führt nur die beiden festen System-Compat-Wurzeln", () => {
    expect(SYSTEM_COMPAT_DIRS).toEqual([
      "/usr/share/steam/compatibilitytools.d",
      "/usr/local/share/steam/compatibilitytools.d",
    ]);
  });
});
