import { describe, expect, it } from "vitest";
import { parseLogRecord } from "../../src/core/logline.js";

describe("parseLogRecord", () => {
  it("zerlegt die kanonische form in zeit, level und nachricht", () => {
    expect(parseLogRecord("[12] [ERROR] kaputt")).toEqual({
      seconds: 12,
      level: "error",
      message: "kaputt",
    });
  });

  it("nimmt nachrichten mit leerzeichen und zeilenumbrüchen vollständig", () => {
    expect(parseLogRecord("[3] [WARN] a: b: c").message).toBe("a: b: c");
  });

  it("unbekannte form bleibt als nackte nachricht ohne zeit und level", () => {
    expect(parseLogRecord("kein muster")).toEqual({
      seconds: null,
      level: "",
      message: "kein muster",
    });
  });

  it("leere nachricht ergibt leeren string statt undefined", () => {
    expect(parseLogRecord("[7] [INFO] ")).toEqual({ seconds: 7, level: "info", message: "" });
  });
});
