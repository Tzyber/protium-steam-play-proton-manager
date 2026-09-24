import { describe, expect, it } from "vitest";
import { errText } from "../../src/core/errtext";
import { formatBytes, formatKnownBytes, sizeText } from "../../src/ui/format";

describe("formatBytes", () => {
  it("unbekannt → auslassungspunkte", () => {
    expect(formatBytes(undefined)).toBe("…");
  });
  it("0 und negativ → bindestrich (leer/ungültig ≠ fehlend)", () => {
    expect(formatBytes(0)).toBe("-");
    expect(formatBytes(-5)).toBe("-");
  });
  it("bytes ohne dezimalstelle", () => {
    expect(formatBytes(512)).toBe("512 B");
  });
  it("1024 → 1.0 KB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });
  it("1536 → 1.5 KB", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
  it("ab 100 einheiten keine dezimalstelle", () => {
    expect(formatBytes(100 * 1024)).toBe("100 KB");
  });
  it("deckel bei TB", () => {
    expect(formatBytes(5 * 1024 ** 4)).toBe("5.0 TB");
  });
});

describe("formatKnownBytes", () => {
  it("belegte 0 → 0 B, sonst wie formatBytes", () => {
    expect(formatKnownBytes(0)).toBe("0 B");
    expect(formatKnownBytes(1536)).toBe("1.5 KB");
  });
});

describe("sizeText", () => {
  it("fehlend → platzhalter, sonst wie formatBytes", () => {
    expect(sizeText(undefined)).toBe("…");
    expect(sizeText(1536)).toBe("1.5 KB");
    expect(sizeText(0)).toBe("-");
  });

  it("gemessene 0 zählt als 0 B, nicht als leer", () => {
    expect(sizeText(0, { measured: true })).toBe("0 B");
  });

  it("unbrauchbare werte bleiben der platzhalter, auch als eigener text", () => {
    expect(sizeText(undefined, { missing: "nicht gemessen" })).toBe("nicht gemessen");
    expect(sizeText(-1, { missing: "nicht gemessen" })).toBe("nicht gemessen");
    expect(sizeText(1.5)).toBe("…");
  });
});

describe("errText", () => {
  it("string-rejection (rust-command) bleibt erhalten", () => {
    expect(errText("forbidden path")).toBe("forbidden path");
  });
  it("Error → message", () => {
    expect(errText(new Error("kaputt"))).toBe("kaputt");
  });
  it("sonstiges → String()", () => {
    expect(errText(null)).toBe("null");
    expect(errText(7)).toBe("7");
  });
});
