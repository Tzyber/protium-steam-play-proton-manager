import { describe, expect, it } from "vitest";
import { ProtiumError, SteamRunningError } from "../../src/core/errors.js";
import { formatDetail, formatError } from "../../src/ui/formatError.js";
import { setLocale, t } from "../../src/ui/i18n/index.js";

describe("formatError (B1)", () => {
  it("formatiert bekannte Fehlercodes auf Deutsch", () => {
    setLocale("de");
    expect(formatError(new SteamRunningError())).toContain("Steam läuft gerade");
    expect(formatError("steam-not-found")).toContain("Keine Steam-Installation");
    expect(formatError("handler-unavailable")).toContain("Kein passender System-Handler");
    expect(formatError("tool-already-exists")).toContain("Tool existiert am Zielort bereits");
    expect(formatError("target-changed")).toContain("Ziel hat sich");
    expect(formatError("cancelled")).toContain("abgebrochen");
    expect(formatError("steam-root-symlink-unsupported: /tmp/evil")).toContain(
      "nicht unterstützten Ort",
    );
    expect(formatError("too-large-for-trash")).toContain("zu viele Dateien");
  });

  it("formatiert bekannte Fehlercodes auf Englisch", () => {
    setLocale("en");
    expect(formatError(new SteamRunningError())).toContain("Steam is currently running");
    expect(formatError("steam-not-found")).toContain("No Steam installation found");
    expect(formatError("handler-unavailable")).toContain("No suitable system handler");
    expect(formatError("tool-already-exists")).toContain("Tool already exists");
    expect(formatError("steam-root-symlink-unsupported")).toContain("symbolic link");
    expect(formatError("too-large-for-trash")).toContain("too many files");
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

  // P8: ein nicht prüfbarer Steam-Status ist eine Sperre, kein unklarer
  // einzelfall. Der Text muss die Reichweite nennen (Schreiben/Löschen) und
  // die einzige ausnahme (Papierkorb), sonst rätselt die oberfläche.
  it("zeigt den nicht prüfbaren Steam-Status als Sperre (P8)", () => {
    // exakt gepinnt statt per Substring: der Text ist die einzige stelle, an
    // der die reichweite (schreiben/löschen) und die ausnahme (papierkorb)
    // benannt sind. Das Detail ("/proc") darf nicht durchschlagen.
    setLocale("de");
    const deText =
      "Steam-Status ist nicht prüfbar; Schreiben und Löschen bleiben gesperrt, ausgenommen ist nur der Papierkorb.";
    expect(t("errors.codes.steamCheckUnavailable")).toBe(deText);
    expect(formatError("steam-check-unavailable")).toBe(deText);
    expect(formatError(new Error("steam-check-unavailable: /proc"))).toBe(deText);

    setLocale("en");
    expect(formatError("steam-check-unavailable")).toBe(t("errors.codes.steamCheckUnavailable"));
    expect(formatError("steam-check-unavailable")).toBe(
      "Steam status cannot be checked; writing and deleting stay locked, except for the trash.",
    );
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

  // 5.6: bei `incomplete` ist das detail die handlungsanweisung
  // (Extraktionsreste, Pfadliste). Es bleibt in der klammer und wird nicht
  // verworfen; andere klassen halten rohtext weiter draußen.
  it("zeigt bei incomplete die Detailklammer", () => {
    setLocale("de");
    const raw =
      "incomplete: incomplete extraction leftovers found: .protium-extract-abc, .protium-extract-def; remove them manually";

    expect(formatError(raw)).toBe(
      `${t("errors.kinds.incomplete")} (incomplete extraction leftovers found: .protium-extract-abc, .protium-extract-def; remove them manually)`,
    );
  });

  it("zeigt ein incomplete-detail auch an einer ProtiumError", () => {
    setLocale("de");
    const err = new ProtiumError(
      "incomplete",
      "incomplete",
      "incomplete extraction leftovers found",
      "incomplete extraction leftovers found: .protium-extract-abc",
    );

    expect(formatError(err)).toBe(
      `${t("errors.kinds.incomplete")} (incomplete extraction leftovers found: .protium-extract-abc)`,
    );
  });

  it.each([
    ["blocked-location", "blocked-location: /home/dominik/secret", "errors.codes.blockedLocation"],
    ["unreadable", "unreadable: cannot read /etc/passwd", "errors.kinds.unreadable"],
    ["not-found", "not-found: /home/dominik/secret", "errors.codes.notFound"],
    // spezifische codes der klasse incomplete tragen diagnostik, keine
    // handlungsanweisung; ihr detail bleibt draußen (Q-03).
    ["size-invalid", "size-invalid: /home/dominik/secret", "errors.codes.sizeInvalid"],
    [
      "manifest-invalid-appid",
      "manifest-invalid-appid: /etc/passwd",
      "errors.codes.manifestInvalidAppid",
    ],
  ] as const)("verbirgt das detail für %s weiterhin", (_fall, raw, key) => {
    setLocale("de");
    expect(formatError(raw)).not.toContain("/home/dominik");
    expect(formatError(raw)).not.toContain("/etc/passwd");
    expect(formatError(raw)).toBe(t(key));
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

  // N-3: die absichtsfehler der stores (configStore, protonStore) tragen eigene
  // codes. ohne code-mapping fielen sie auf "unbekannt" zurück und die ursache
  // war nirgends sichtbar.
  it("zeigt die absichtsfehler der stores mit ihrem gepflegten text", () => {
    setLocale("de");
    expect(formatError(new ProtiumError("not-found", "no-scan-result", "rohtext"))).toBe(
      t("errors.noScanResult"),
    );
    expect(formatError(new ProtiumError("not-found", "no-steam-account", "rohtext"))).toBe(
      t("errors.noSteamAccount"),
    );

    setLocale("en");
    expect(formatError(new ProtiumError("not-found", "no-scan-result", "raw"))).toBe(
      t("errors.noScanResult"),
    );
    expect(formatError(new ProtiumError("not-found", "no-steam-account", "raw"))).toBe(
      t("errors.noSteamAccount"),
    );
  });
});
