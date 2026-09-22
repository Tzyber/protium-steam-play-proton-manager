import { describe, expect, it } from "vitest";
import { ProtiumError, SteamRunningError } from "../../src/core/errors.js";
import { formatError } from "../../src/ui/formatError.js";
import { setLocale } from "../../src/ui/i18n/index.js";

describe("formatError (B1)", () => {
  it("formatiert bekannte Fehlercodes auf Deutsch", () => {
    setLocale("de");
    expect(formatError(new SteamRunningError())).toContain("Steam läuft gerade");
    expect(formatError("steam-not-found")).toContain("Keine Steam-Installation");
    expect(formatError("handler-unavailable")).toContain("Kein passender System-Handler");
    expect(formatError("tool-already-exists")).toContain("Tool existiert am Zielort bereits");
    expect(formatError("target-changed")).toContain("Ziel hat sich");
    expect(formatError("cancelled")).toContain("abgebrochen");
  });

  it("formatiert bekannte Fehlercodes auf Englisch", () => {
    setLocale("en");
    expect(formatError(new SteamRunningError())).toContain("Steam is currently running");
    expect(formatError("steam-not-found")).toContain("No Steam installation found");
    expect(formatError("handler-unavailable")).toContain("No suitable system handler");
    expect(formatError("tool-already-exists")).toContain("Tool already exists");
  });

  it("zeigt nie einen rohen Backend-Text", () => {
    setLocale("de");
    const raw = formatError("steam is running, write refused");
    expect(raw).toBe("unbekannt");
    expect(raw).not.toContain("steam");

    setLocale("en");
    expect(formatError("cannot read backup dir: permission denied")).toBe("unknown");
  });

  it("faellt auf Fehlerklasse zurueck wenn Code unbekannt", () => {
    setLocale("de");
    const err = new ProtiumError("blocked", "custom-security-gate", "verweigert");
    expect(formatError(err)).toBe("aus Sicherheitsgründen blockiert");

    const unreadable = new ProtiumError("unreadable", "unknown-read-fail", "lesefehler");
    expect(formatError(unreadable)).toBe("unlesbar");

    const incomplete = new ProtiumError("incomplete", "irgendwas", "teilweise");
    expect(formatError(incomplete)).toBe("unvollständig");
  });
});
