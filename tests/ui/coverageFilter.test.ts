import { describe, expect, it } from "vitest";
import type { ScanWarning } from "../../src/core/types";
import { filterWarningsByType } from "../../src/ui/coverageFilter";

const warnings: ScanWarning[] = [
  { type: "compat-config", reason: "missing" },
  { type: "launch-config", reason: "unreadable" },
  {
    type: "manifest",
    library: "/games",
    manifestName: "appmanifest_42.acf",
    reason: "invalid-content",
  },
];

describe("filterWarningsByType", () => {
  it("filtert einen einzelnen typ korrekt", () => {
    const result: Extract<ScanWarning, { type: "manifest" }>[] = filterWarningsByType(
      warnings,
      "manifest",
    );
    expect(result).toEqual([warnings[2]]);
  });

  it("filtert mehrere typen über ein array", () => {
    const result: Extract<ScanWarning, { type: "compat-config" | "launch-config" }>[] =
      filterWarningsByType(warnings, ["compat-config", "launch-config"]);
    expect(result).toEqual([warnings[0], warnings[1]]);
  });

  it("liefert bei leerer eingabe ein leeres array", () => {
    expect(filterWarningsByType([], "manifest")).toEqual([]);
  });

  it("liefert bei keinem treffer ein leeres array", () => {
    expect(filterWarningsByType(warnings, "library")).toEqual([]);
  });
});
