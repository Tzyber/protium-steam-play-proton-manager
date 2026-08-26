import { describe, expect, it } from "vitest";
import { deriveScanCoverage } from "../../../src/core/scan/coverage.js";
import type { ScanResult } from "../../../src/core/types.js";

function result(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    steamRoot: "/steam",
    libraries: ["/steam", "/games"],
    games: [],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: null,
    compatConfigStatus: "available",
    launchConfigStatus: "available",
    steamUserId: "123",
    manifestCounts: { read: 2, failed: 0 },
    compatToolCounts: { read: 1, failed: 0 },
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
    ...overrides,
  };
}

describe("deriveScanCoverage", () => {
  it("meldet einen vollständigen Scan", () => {
    expect(deriveScanCoverage(result())).toEqual({
      state: "complete",
      libraries: { total: 2, read: 2, unavailable: 0 },
      compatConfig: "available",
      launchConfig: "available",
      manifests: { read: 2, failed: 0 },
      tools: { read: 1, failed: 0 },
    });
  });

  it.each(["path-missing", "scope-failed", "read-failed"] as const)(
    "wertet %s als unvollständig",
    (reason) => {
      const coverage = deriveScanCoverage(
        result({
          libraries: ["/steam"],
          skippedLibraries: [{ path: "/external", reason }],
        }),
      );

      expect(coverage.state).toBe("incomplete");
      expect(coverage.libraries).toEqual({ total: 2, read: 1, unavailable: 1 });
    },
  );

  it("vereinigt Library-Pfade eindeutig und dedupliziert Skip-Einträge", () => {
    const coverage = deriveScanCoverage(
      result({
        libraries: ["/steam", "/steam"],
        skippedLibraries: [
          { path: "/games", reason: "path-missing" },
          { path: "/games", reason: "path-missing" },
          { path: "/other", reason: "scope-failed" },
        ],
      }),
    );

    expect(coverage.libraries).toEqual({ total: 3, read: 1, unavailable: 2 });
    expect(coverage.state).toBe("incomplete");
  });

  it.each([
    { compatConfigStatus: "unreadable" as const },
    { launchConfigStatus: "unreadable" as const },
    { manifestCounts: { read: 1, failed: 1 } },
    { compatToolCounts: { read: 0, failed: 1 } },
  ])("wertet Teilfehler als unvollständig: %j", (overrides) => {
    expect(deriveScanCoverage(result(overrides)).state).toBe("incomplete");
  });

  it.each([
    { compatConfigStatus: "missing" as const },
    { launchConfigStatus: "missing" as const },
    {
      compatConfigStatus: "missing" as const,
      launchConfigStatus: "missing" as const,
    },
  ])("wertet fehlende optionale Konfiguration als eingeschränkt: %j", (overrides) => {
    expect(deriveScanCoverage(result(overrides)).state).toBe("limited");
  });

  it("stuft fehlende Konfiguration mit Teilfehler als unvollständig ein", () => {
    expect(
      deriveScanCoverage(
        result({
          compatConfigStatus: "missing",
          manifestCounts: { read: 1, failed: 1 },
        }),
      ).state,
    ).toBe("incomplete");
  });

  it("wertet eine mehrdeutige launch-config als eingeschränkt", () => {
    const coverage = deriveScanCoverage(
      result({
        launchConfigStatus: "ambiguous",
        warnings: [
          {
            type: "launch-config",
            reason: "selection-ambiguous",
            steamUserId: "123",
            detail: "beliebiger Text mit unreadable und missing",
          },
        ],
      }),
    );

    expect(coverage.state).toBe("limited");
    expect(coverage.launchConfig).toBe("ambiguous");
  });

  it("stuft mehrdeutige launch-config mit manifestfehler als unvollständig ein", () => {
    const coverage = deriveScanCoverage(
      result({
        launchConfigStatus: "ambiguous",
        manifestCounts: { read: 1, failed: 1 },
      }),
    );

    expect(coverage.state).toBe("incomplete");
  });

  it("wertet die selection-ambiguous-warning ohne status nicht aus", () => {
    const coverage = deriveScanCoverage(
      result({
        warnings: [
          {
            type: "launch-config",
            reason: "selection-ambiguous",
            steamUserId: "123",
            detail: "beliebiger Text mit unreadable und missing",
          },
        ],
      }),
    );

    expect(coverage.state).toBe("complete");
  });
});
