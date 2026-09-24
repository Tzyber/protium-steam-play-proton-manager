import { describe, expect, it } from "vitest";
import { sameContext } from "../../src/ui/sameContext";

interface Context {
  appId: number;
  generation: number;
}

const same = sameContext<Context>(["appId", "generation"]);

describe("sameContext", () => {
  it("gleiche feldwerte sind der gleiche kontext", () => {
    expect(same({ appId: 1, generation: 2 }, { appId: 1, generation: 2 })).toBe(true);
  });

  it("ein abweichendes feld ist ein wechsel", () => {
    expect(same({ appId: 1, generation: 2 }, { appId: 1, generation: 3 })).toBe(false);
    expect(same({ appId: 1, generation: 2 }, { appId: 9, generation: 2 })).toBe(false);
  });

  it("genau ein null ist ein wechsel, zwei null sind gleich", () => {
    expect(same({ appId: 1, generation: 2 }, null)).toBe(false);
    expect(same(null, { appId: 1, generation: 2 })).toBe(false);
    expect(same(null, null)).toBe(true);
  });
});
