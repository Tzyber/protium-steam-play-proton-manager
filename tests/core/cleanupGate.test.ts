import { describe, expect, it } from "vitest";
import type { IncompleteDeletion, OrphanUnreadable } from "../../src/core/cleanup.js";
import {
  cleanupBlockedFlags,
  cleanupTurn,
  collectInstalledAppIds,
  hasOrphanUnavailableBase,
  hasUnreadableOrphanType,
  isCurrentForScan,
  mergeOrphanUnreadable,
  resolveOrphanBlockReason,
  scanBlockers,
  unansweredPathMissingLibs,
} from "../../src/core/cleanupGate.js";
import type { ShortcutResult } from "../../src/core/shortcuts.js";
import type { TrashLibraryStatus } from "../../src/core/trash.js";
import type { ScanResult } from "../../src/core/types.js";
import { game as makeGame, scanResult } from "../support/factories";

describe("scanBlockers", () => {
  it("liefert null bei verletztem scan-vertrag (fail-closed)", () => {
    const missingSafety = scanResult();
    Reflect.deleteProperty(missingSafety, "cleanupUnsafeLibraries");
    expect(scanBlockers(missingSafety)).toBeNull();

    const badSafety = scanResult();
    (badSafety as { cleanupUnsafeLibraries: unknown }).cleanupUnsafeLibraries = ["/ok", 42];
    expect(scanBlockers(badSafety)).toBeNull();

    const badBlocked = scanResult();
    (badBlocked as { blockedAppIds: unknown }).blockedAppIds = ["1628350", 0];
    expect(scanBlockers(badBlocked)).toBeNull();
  });

  it("liefert blockier-pfade aus skipped und cleanupUnsafeLibraries, lässt path-missing aus", () => {
    const result = scanResult({
      skippedLibraries: [
        { path: "/gone", reason: "path-missing" },
        { path: "/scope", reason: "scope-failed" },
        { path: "/read", reason: "read-failed" },
      ],
      cleanupUnsafeLibraries: ["/unsafe"],
    });
    expect(scanBlockers(result)).toEqual(["/scope", "/read", "/unsafe"]);
  });
});

describe("unansweredPathMissingLibs", () => {
  it("filtert unbeantwortete path-missing-bibliotheken heraus", () => {
    expect(
      unansweredPathMissingLibs(
        [
          { path: "/gone/a", reason: "path-missing" },
          { path: "/gone/b", reason: "path-missing" },
          { path: "/scope", reason: "scope-failed" },
        ],
        ["/gone/a"],
      ),
    ).toEqual(["/gone/b"]);
  });
});

describe("resolveOrphanBlockReason", () => {
  const base = {
    orphanUnreadable: [] as OrphanUnreadable[],
    incompleteDeletionsUnreadable: [] as string[],
    incompleteDeletions: [] as { type: IncompleteDeletion["type"] }[],
    orphanScanError: null as string | null,
  };

  it("wählt den konkretesten grund nach M1-reihenfolge", () => {
    expect(
      resolveOrphanBlockReason(
        {
          orphanUnreadable: [
            { path: "/lib/compatdata", type: "compatdata" },
            { path: "/lib/shadercache", type: "shadercache" },
          ],
          incompleteDeletionsUnreadable: ["/claim-parent"],
          incompleteDeletions: [{ type: "compatdata" }],
          orphanScanError: "scan fail",
        },
        ["compatdata"],
      ),
    ).toEqual({ kind: "unreadable-dirs", paths: ["/lib/compatdata"] });

    expect(
      resolveOrphanBlockReason(
        {
          ...base,
          incompleteDeletionsUnreadable: ["/claim-parent"],
          incompleteDeletions: [{ type: "compatdata" }],
          orphanScanError: "scan fail",
        },
        ["compatdata"],
      ),
    ).toEqual({ kind: "claims-unreadable", paths: ["/claim-parent"] });

    expect(
      resolveOrphanBlockReason(
        {
          ...base,
          incompleteDeletions: [{ type: "compatdata" }],
          orphanScanError: "scan fail",
        },
        ["compatdata"],
      ),
    ).toEqual({ kind: "incomplete-deletions" });

    expect(
      resolveOrphanBlockReason(
        {
          ...base,
          incompleteDeletions: [{ type: "shadercache" }],
          orphanScanError: "scan fail",
        },
        ["compatdata"],
      ),
    ).toEqual({ kind: "scan-error", message: "scan fail" });

    expect(resolveOrphanBlockReason(base, ["compatdata"])).toBeNull();
  });
});

describe("cleanupGate (basisregeln)", () => {
  it("prüft isCurrentForScan und cleanupTurn", () => {
    expect(
      isCurrentForScan({
        generation: 2,
        currentGeneration: 2,
        sourceScanGeneration: 7,
        scan: { status: "done", scanGeneration: 7 },
      }),
    ).toBe(true);
    expect(
      isCurrentForScan({
        generation: 2,
        currentGeneration: 2,
        sourceScanGeneration: 7,
        scan: { status: "scanning", scanGeneration: 7 },
      }),
    ).toBe(false);

    const scanState = { status: "done", result: { ok: true }, scanGeneration: 3 };
    let currentGen = 1;
    const turn = cleanupTurn(scanState, 1, () => currentGen);
    expect(turn.result).toEqual({ ok: true });
    expect(turn.isCurrent()).toBe(true);
    scanState.scanGeneration = 4;
    expect(turn.isCurrent()).toBe(false);
    scanState.scanGeneration = 3;
    currentGen = 2;
    expect(turn.isCurrent()).toBe(false);
  });

  it("collectInstalledAppIds, mergeOrphanUnreadable und cleanupBlockedFlags arbeiten UI-frei", () => {
    const result: ScanResult = scanResult({ games: [makeGame({ appId: 10 })] });
    const shortcuts: ShortcutResult = { status: "ok", ids: new Set([3000000000]) };
    expect([...collectInstalledAppIds(result, shortcuts)].sort((a, b) => a - b)).toEqual([
      10, 3000000000,
    ]);

    expect(
      mergeOrphanUnreadable(
        [{ path: "/a", type: "compatdata" }],
        [
          { path: "/a", type: "compatdata" },
          { path: "/a", type: "shadercache" },
        ],
      ),
    ).toEqual([
      { path: "/a", type: "compatdata" },
      { path: "/a", type: "shadercache" },
    ]);

    const baseState = {
      orphanError: null,
      blockedBySkipped: false,
      pathMissingLibs: [] as string[],
      incompleteDeletionsUnreadable: [] as string[],
      orphanUnreadable: [] as OrphanUnreadable[],
    };
    expect(hasOrphanUnavailableBase(baseState)).toBe(false);
    expect(hasUnreadableOrphanType(baseState, "compatdata")).toBe(false);

    expect(
      cleanupBlockedFlags({
        orphanScanError: null,
        blockedBySkipped: false,
        pathMissingLibs: [],
        incompleteDeletionsUnreadable: [],
        shortcutUnreadable: true,
        orphanUnreadable: [],
        incompleteDeletions: [] as { type: IncompleteDeletion["type"] }[],
        trashScanError: null,
        trashUnknown: [],
        trashLibraries: [] as TrashLibraryStatus[],
      }),
    ).toEqual({
      base: false,
      shader: false,
      prefix: true,
      trash: false,
      trashDelete: false,
      any: true,
    });
  });
});
