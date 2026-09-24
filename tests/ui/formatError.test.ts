import { describe, expect, it } from "vitest";
import { ProtiumError, SteamRunningError } from "../../src/core/errors.js";
import { formatDetail, formatError } from "../../src/ui/formatError.js";
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

  it("formatiert die live-ablehnungen der löschinspektion ohne rohtext", () => {
    setLocale("de");
    expect(formatError('not-an-orphan: game "Portal" (400)')).toContain("Kein verwaister Eintrag");
    expect(formatError("library-not-listed")).toContain("libraryfolders.vdf");
    expect(formatError("not-a-managed-tool")).toContain("GE-Proton");
    expect(formatError("invalid-id")).toBe("Ungültige Kennung.");

    setLocale("en");
    expect(formatError("not-an-orphan")).toContain("Not an orphaned entry");
  });

  it("zeigt nie einen rohen Backend-Text", () => {
    setLocale("de");
    const raw = formatError("steam is running, write refused");
    expect(raw).toBe("unbekannt");
    expect(raw).not.toContain("steam");

    setLocale("en");
    expect(formatError("cannot read backup dir: permission denied")).toBe("unknown");
  });

  // Der Vertrag aus errcode.rs: das Detail (darf Pfade tragen) landet im Log,
  // nicht in der Uebersetzung. Diese Erwartung haelt den Vertrag auf der
  // UI-Seite fest, damit kein spaeterer Umbau das Detail durchreicht.
  it("rendert kein Detail, weder bei bekanntem Code noch bei Rohtext", () => {
    setLocale("de");
    const withPath =
      "blocked-location: /home/dominik/.steam/steam/userdata/12345/config/localconfig.vdf";
    expect(formatError(withPath)).toBe("Der Ort ist aus Sicherheitsgründen gesperrt.");
    expect(formatDetail(withPath)).not.toContain("/home/dominik");

    expect(formatDetail("unreadable: cannot read /etc/passwd: Permission denied")).not.toContain(
      "/etc/passwd",
    );
    expect(formatDetail("/etc/passwd ist kaputt")).toBeUndefined();
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
