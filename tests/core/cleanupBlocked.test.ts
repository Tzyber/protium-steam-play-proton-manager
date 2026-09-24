import { describe, expect, it } from "vitest";
import { blockedReport } from "../../src/core/cleanupBlocked.js";
import { scanResult } from "../support/factories";

describe("blockedReport", () => {
  it("liefert ohne scan-ergebnis keine eintraege", () => {
    expect(blockedReport(null)).toEqual([]);
  });

  it("laesst path-missing aus: dieser fall hat eine eigene hinweisflaeche", () => {
    const report = blockedReport(
      scanResult({ skippedLibraries: [{ path: "/eingebunden", reason: "path-missing" }] }),
    );
    expect(report).toEqual([]);
  });

  it("uebersetzt jeden grund in die kanonische fehlerklasse", () => {
    const report = blockedReport(
      scanResult({
        skippedLibraries: [
          { path: "/scope", reason: "scope-failed" },
          { path: "/read", reason: "read-failed" },
          { path: "/unverified", reason: "unverified" },
        ],
      }),
    );

    expect(report).toEqual([
      { path: "/scope", kind: "blocked" },
      { path: "/read", kind: "unreadable" },
      { path: "/unverified", kind: "incomplete" },
    ]);
  });

  it("meldet cleanup-unsichere libraries als blockiert", () => {
    const report = blockedReport(
      scanResult({ cleanupUnsafeLibraries: ["/unsicher", "/auch-unsicher"] }),
    );
    expect(report).toEqual([
      { path: "/unsicher", kind: "blocked" },
      { path: "/auch-unsicher", kind: "blocked" },
    ]);
  });

  it("haelt die reihenfolge skippedLibraries vor cleanupUnsafeLibraries", () => {
    const report = blockedReport(
      scanResult({
        skippedLibraries: [{ path: "/skip", reason: "scope-failed" }],
        cleanupUnsafeLibraries: ["/cleanup"],
      }),
    );
    expect(report.map((item) => item.path)).toEqual(["/skip", "/cleanup"]);
  });

  it("dedupliziert nach pfad und behaelt den ersten grund", () => {
    const report = blockedReport(
      scanResult({
        skippedLibraries: [
          { path: "/doppelt", reason: "read-failed" },
          { path: "/doppelt", reason: "scope-failed" },
        ],
      }),
    );
    expect(report).toEqual([{ path: "/doppelt", kind: "unreadable" }]);
  });

  it("dedupliziert auch ueber skippedLibraries und cleanupUnsafeLibraries", () => {
    const report = blockedReport(
      scanResult({
        skippedLibraries: [{ path: "/beides", reason: "scope-failed" }],
        cleanupUnsafeLibraries: ["/beides"],
      }),
    );
    expect(report).toEqual([{ path: "/beides", kind: "blocked" }]);
  });

  it("behaelt einen cleanup-unsicheren pfad, der zugleich path-missing war", () => {
    // path-missing wird verworfen, bevor dedupliziert wird: der pfad bleibt
    // ueber den cleanup-grund sichtbar (blockiert, nicht "nicht eingebunden").
    const report = blockedReport(
      scanResult({
        skippedLibraries: [{ path: "/beides", reason: "path-missing" }],
        cleanupUnsafeLibraries: ["/beides"],
      }),
    );
    expect(report).toEqual([{ path: "/beides", kind: "blocked" }]);
  });
});
