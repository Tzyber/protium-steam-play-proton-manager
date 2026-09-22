import { describe, expect, it } from "vitest";
import { median } from "../support/median.js";

describe("median der benchmark-messwerte (N4)", () => {
  it("nimmt bei ungerader länge den mittleren wert, nicht das mittel der beiden unteren", () => {
    // audit-beispiel: 5 läufe. der alte code meldete 55 statt 100.
    expect(median([10, 10, 100, 100, 100])).toBe(100);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([40])).toBe(40);
  });

  it("mittelt bei gerader länge die beiden mittleren werte", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 20])).toBe(15);
  });

  it("wirft ohne messwerte, statt still 0 zu melden", () => {
    expect(() => median([])).toThrow();
  });
});
