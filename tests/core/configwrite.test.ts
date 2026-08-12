import { describe, expect, it, vi } from "vitest";
import { SteamRunningError, writeSteamFile } from "../../src/core/configwrite.js";
import { fakeSystem } from "../support/fakeSteam.js";

// M3.1: das INV-1-write-gate selbst (steam-läuft → backup → atomarer write)
// liegt in rust (`write_steam_file`, cargo-getestet). diese schicht baut den
// backup-pfad und reicht den originalstand durch, hier wird der kontrakt
// getestet, nicht die disk-logik.

describe("writeSteamFile (INV-1 write-gate, kontrakt)", () => {
  it("blockt bei laufendem steam, writeSteamConfigFile nie aufgerufen", async () => {
    const system = { ...fakeSystem(), isProcessRunning: async () => true };
    const spy = vi.fn(system.writeSteamConfigFile);
    system.writeSteamConfigFile = spy;

    await expect(
      writeSteamFile(system, "/steam/config/config.vdf", "NEU", "/backups", "IRRELEVANT"),
    ).rejects.toBeInstanceOf(SteamRunningError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reicht (file, original, content, backup-pfad) an den rust-command durch", async () => {
    const system = fakeSystem();
    const spy = vi.fn(); // reiner mock, kein disk-zustand im kontrakt-test
    system.writeSteamConfigFile = spy;

    await writeSteamFile(system, "/steam/config/config.vdf", "NEU", "/cache/backups", "ORIGINAL");

    expect(spy).toHaveBeenCalledTimes(1);
    const [file, original, content, backup] = spy.mock.calls[0] ?? [];
    expect(file).toBe("/steam/config/config.vdf");
    // backupText wird unverändert als original durchgereicht (TOCTOU-basis:
    // das backup ist der übergebene stand, nie ein disk-reread)
    expect(original).toBe("ORIGINAL");
    expect(content).toBe("NEU");
    expect(backup).toMatch(/^\/cache\/backups\/config\.vdf\.\d{4}-\d{2}-\d{2}T/);
  });
});
