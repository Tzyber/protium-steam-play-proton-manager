import { describe, expect, it } from "vitest";
import { readLibraryList } from "../../../src/core/scan/libraries.js";
import { buildFakeSteam } from "../../support/fakeSteam";

describe("readLibraryList", () => {
  it("verwendet ausschließlich die backendgelieferte Library-Liste", async () => {
    const { environment, root, lib2 } = await buildFakeSteam();
    const result = readLibraryList({ ...environment, libraries: [root, lib2] });

    expect(result.libraries).toEqual([root, lib2]);
    expect(result.warnings).toEqual([]);
    expect(result.skippedLibraries).toEqual([]);
  });

  it("reicht leere Listen fail-closed weiter", () => {
    const result = readLibraryList({
      generation: 1,
      steamRoot: "/tmp/steam",
      libraries: [],
      unavailableLibraries: [],
      systemCompatDirs: [],
      appCacheDir: "/tmp/cache",
      appConfigDir: "/tmp/config",
    });

    expect(result.libraries).toEqual([]);
  });

  it("meldet fehlgeschlagene discovery als warning und skip", () => {
    const result = readLibraryList({
      generation: 1,
      steamRoot: "/tmp/steam",
      libraries: ["/tmp/steam"],
      unavailableLibraries: [
        { path: "/mnt/fehlt", reason: "path-missing" },
        { path: "/mnt/gesperrt", reason: "scope-failed" },
        { path: "/mnt/kaputt", reason: "read-failed" },
      ],
      systemCompatDirs: [],
      appCacheDir: "/tmp/cache",
      appConfigDir: "/tmp/config",
    });

    expect(result.libraries).toEqual(["/tmp/steam"]);
    expect(result.skippedLibraries).toEqual([
      { path: "/mnt/fehlt", reason: "path-missing" },
      { path: "/mnt/gesperrt", reason: "scope-failed" },
      { path: "/mnt/kaputt", reason: "read-failed" },
    ]);
    expect(result.warnings).toEqual([
      {
        type: "library",
        path: "/mnt/fehlt",
        reason: "path-missing",
        detail: 'library "/mnt/fehlt" unavailable during discovery: path-missing',
      },
      {
        type: "library",
        path: "/mnt/gesperrt",
        reason: "scope-failed",
        detail: 'library "/mnt/gesperrt" unavailable during discovery: scope-failed',
      },
      {
        type: "library",
        path: "/mnt/kaputt",
        reason: "read-failed",
        detail: 'library "/mnt/kaputt" unavailable during discovery: read-failed',
      },
    ]);
  });

  it("dedupliziert discovery-einträge und liest keinen zugleich gelesenen pfad", () => {
    const result = readLibraryList({
      generation: 1,
      steamRoot: "/tmp/steam",
      libraries: ["/tmp/steam", "/mnt/gelesen"],
      unavailableLibraries: [
        { path: "/mnt/doppelt", reason: "read-failed" },
        { path: "/mnt/doppelt", reason: "read-failed" },
        { path: "/mnt/gelesen", reason: "path-missing" },
      ],
      systemCompatDirs: [],
      appCacheDir: "/tmp/cache",
      appConfigDir: "/tmp/config",
    });

    expect(result.skippedLibraries).toEqual([{ path: "/mnt/doppelt", reason: "read-failed" }]);
    expect(result.warnings).toHaveLength(1);
  });

  it("degradiert sichtbar, wenn der snapshot die discovery-fehler nicht belegt", () => {
    // F1: ein snapshot ohne das feld (versionsversatz) darf den scan weder
    // werfen lassen noch die abdeckung als vollständig ausgeben.
    const snapshot = {
      generation: 1,
      steamRoot: "/tmp/steam",
      libraries: ["/tmp/steam"],
      systemCompatDirs: [],
      appCacheDir: "/tmp/cache",
      appConfigDir: "/tmp/config",
    };
    const result = readLibraryList(snapshot as unknown as Parameters<typeof readLibraryList>[0]);

    expect(result.libraries).toEqual(["/tmp/steam"]);
    expect(result.skippedLibraries).toEqual([{ path: "/tmp/steam", reason: "unverified" }]);
    expect(result.warnings).toEqual([
      {
        type: "library",
        path: "/tmp/steam",
        reason: "unverified",
        detail: "the backend snapshot does not report unavailable libraries",
      },
    ]);
  });
});
