import { describe, expect, it } from "vitest";
import { summarizeSizes } from "../../src/ui/sizeSummary";

describe("summarizeSizes", () => {
  it("unterscheidet vollständige, teilweise und vollständig unbekannte summen", () => {
    expect(summarizeSizes([{ sizeBytes: 0 }, { sizeBytes: 8 }])).toEqual({
      measuredBytes: 8,
      unknownCount: 0,
    });
    expect(summarizeSizes([{ sizeBytes: 8 }, {}])).toEqual({
      measuredBytes: 8,
      unknownCount: 1,
    });
    expect(summarizeSizes([{}, {}])).toEqual({
      measuredBytes: 0,
      unknownCount: 2,
    });
  });
});
