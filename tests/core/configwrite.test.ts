import { describe, expect, it } from "vitest";
import { SteamRunningError } from "../../src/core/configwrite.js";

describe("SteamRunningError", () => {
  it("besitzt den erwarteten Namen und Fehlermeldung", () => {
    const err = new SteamRunningError();
    expect(err.name).toBe("SteamRunningError");
    expect(err.message).toContain("steam läuft gerade");
  });
});
