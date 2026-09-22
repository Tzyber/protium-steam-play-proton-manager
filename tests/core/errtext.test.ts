import { describe, expect, it } from "vitest";
import { SteamRunningError } from "../../src/core/errors.js";
import { errText, parseError } from "../../src/core/errtext.js";

describe("errtext und parseError (B1)", () => {
  it("errText extrahiert Fehlermeldungen konsistent", () => {
    expect(errText("roher fehler")).toBe("roher fehler");
    expect(errText(new Error("fehler im objekt"))).toBe("fehler im objekt");
    expect(errText(123)).toBe("123");
  });

  it("parseError liest den Code, nicht den Meldungstext", () => {
    expect(parseError("steam-running").kind).toBe("blocked");
    expect(parseError("steam-not-found").kind).toBe("not-found");
    expect(parseError("handler-unavailable").kind).toBe("unavailable");
    expect(parseError("blocked-location").kind).toBe("blocked");
    expect(parseError("unreadable").kind).toBe("unreadable");
    expect(parseError("incomplete").kind).toBe("incomplete");
  });

  it("parseError trennt Code und Detail", () => {
    const parsed = parseError("size-limit-exceeded: libraryfolders.vdf");
    expect(parsed.kind).toBe("incomplete");
    expect(parsed.code).toBe("size-limit-exceeded");
    expect(parsed.detail).toBe("libraryfolders.vdf");
  });

  it("parseError klassifiziert die live-ablehnungen der löschinspektion", () => {
    // N9: diese sicherheitsrelevanten Ablehnungen trugen früher nur einen
    // englischen Satz und landeten als "unknown" in der oberfläche.
    expect(parseError("not-an-orphan").kind).toBe("blocked");
    expect(parseError("library-not-listed").kind).toBe("blocked");
    expect(parseError("not-a-managed-tool").kind).toBe("blocked");
    expect(parseError("invalid-id").kind).toBe("unknown");

    const parsed = parseError('not-an-orphan: game "Portal" (400) is currently installed');
    expect(parsed.code).toBe("not-an-orphan");
    expect(parsed.kind).toBe("blocked");
    expect(parsed.detail).toBe('game "Portal" (400) is currently installed');
  });

  it("unbekannte Texte bleiben unknown, ohne zu raten", () => {
    // Ein alter englischer Satz ist kein Code und wird nicht klassifiziert.
    const parsed = parseError("steam is running, write refused");
    expect(parsed.kind).toBe("unknown");
    expect(parsed.code).toBe("unknown");
    expect(parseError(null).kind).toBe("unknown");
  });

  it("ProtiumError behaelt Klasse, Code und Detail", () => {
    const parsed = parseError(new SteamRunningError("write"));
    expect(parsed.kind).toBe("blocked");
    expect(parsed.code).toBe("steam-running");
    expect(parsed.detail).toBe("write");
  });
});
