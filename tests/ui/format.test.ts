import { describe, expect, it } from "vitest";
import { errText } from "../../src/core/errtext";
import { formatBytes } from "../../src/ui/format";

describe("formatBytes", () => {
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
