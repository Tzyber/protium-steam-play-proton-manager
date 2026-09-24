import { describe, expect, it } from "vitest";
import { isCurrentForScan } from "../../src/ui/stores/cleanupHelpers";

const scanOf = (status: string, scanGeneration: number) => ({ status, scanGeneration });

describe("isCurrentForScan", () => {
  it("gilt bei eigener und fremder generation sowie gültigem scan-stand", () => {
    expect(
      isCurrentForScan({
        generation: 1,
        currentGeneration: 1,
        sourceScanGeneration: 4,
        scan: scanOf("done", 4),
      }),
    ).toBe(true);
    expect(
      isCurrentForScan({
        generation: 1,
        currentGeneration: 1,
        sourceScanGeneration: 4,
        scan: scanOf("idle", 4),
      }),
    ).toBe(true);
  });

  it("verwirft eine alte antwort nach library-rescan oder neuer eigener generation", () => {
    expect(
      isCurrentForScan({
        generation: 1,
        currentGeneration: 1,
        sourceScanGeneration: 4,
        scan: scanOf("done", 5),
      }),
    ).toBe(false);
    expect(
      isCurrentForScan({
        generation: 1,
        currentGeneration: 2,
        sourceScanGeneration: 4,
        scan: scanOf("done", 4),
      }),
    ).toBe(false);
    // laufender scan: es gibt keinen gültigen stand, auf den die antwort passt
    expect(
      isCurrentForScan({
        generation: 1,
        currentGeneration: 1,
        sourceScanGeneration: 4,
        scan: scanOf("scanning", 4),
      }),
    ).toBe(false);
  });
});
