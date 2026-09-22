import { describe, expect, it } from "vitest";
import { ManifestParseError, ProtiumError, SteamRunningError } from "../../src/core/errors.js";
import { parseManifest } from "../../src/core/manifest.js";

describe("ProtiumError und Fehlersemantik (B1)", () => {
  it("erstellt ProtiumError mit kanonischer Fehlerklasse", () => {
    const err = new ProtiumError("unavailable", "handler-unavailable", "no handler", "xdg-open");
    expect(err.name).toBe("ProtiumError");
    expect(err.kind).toBe("unavailable");
    expect(err.code).toBe("handler-unavailable");
    expect(err.message).toBe("no handler");
    expect(err.detail).toBe("xdg-open");
    expect(err instanceof Error).toBe(true);
  });

  it("SteamRunningError ist ProtiumError mit Klasse blocked", () => {
    const err = new SteamRunningError();
    expect(err.name).toBe("SteamRunningError");
    expect(err.kind).toBe("blocked");
    expect(err.code).toBe("steam-running");
    expect(err.message).toContain("steam läuft gerade");
    expect(err instanceof ProtiumError).toBe(true);
  });

  it("ManifestParseError ordnet Fehlerklassen unreadable und incomplete zu", () => {
    const missing = new ManifestParseError("manifest-missing-appstate", "missing");
    expect(missing.kind).toBe("unreadable");
    expect(missing.code).toBe("manifest-missing-appstate");

    const invalid = new ManifestParseError("manifest-invalid-appid", "invalid");
    expect(invalid.kind).toBe("incomplete");
    expect(invalid.code).toBe("manifest-invalid-appid");
  });

  it("parseManifest wirft ManifestParseError", () => {
    expect(() => parseManifest('"AppState" { "name" "x" }')).toThrow(ManifestParseError);
    expect(() => parseManifest('"AppState"\n{\n\t"appid"\t\t"0"\n}')).toThrow(ManifestParseError);
  });
});
