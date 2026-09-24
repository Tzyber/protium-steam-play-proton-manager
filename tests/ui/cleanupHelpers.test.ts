import { afterEach, describe, expect, it } from "vitest";
import type { DirectorySize } from "../../src/core/ports";
import type { ShortcutResult } from "../../src/core/shortcuts";
import type { ScanResult } from "../../src/core/types";
import { setLocale, t } from "../../src/ui/i18n";
import {
  attachSizes,
  collectInstalledAppIds,
  combineErrors,
  formatTrashErrors,
  hasOrphanUnavailableBase,
  hasUnreadableIncompleteDeletions,
  isCurrentForScan,
  toggleInSet,
} from "../../src/ui/stores/cleanupHelpers";
import { game as makeGame, scanResult } from "../support/factories";

afterEach(() => setLocale("en"));

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

describe("collectInstalledAppIds", () => {
  const result: ScanResult = scanResult({
    games: [makeGame({ appId: 1 }), makeGame({ appId: 2 })],
  });

  it("nimmt spiele und — bei lesbaren shortcuts — auch deren ids", () => {
    expect([...collectInstalledAppIds(result, { status: "none" })].sort()).toEqual([1, 2]);
    expect(
      [...collectInstalledAppIds(result, { status: "ok", ids: new Set([3641016077]) })].sort(),
    ).toEqual([1, 2, 3641016077]);
  });

  it("ergänzt bei unlesbaren shortcuts keine ids", () => {
    const shortcut: ShortcutResult = { status: "unreadable", paths: ["/x"] };
    expect([...collectInstalledAppIds(result, shortcut)].sort()).toEqual([1, 2]);
  });
});

describe("attachSizes", () => {
  it("übernimmt gemessene größen und lässt fehlende/failed leer", () => {
    const entries: { path: string; sizeBytes?: number }[] = [
      { path: "/measured" },
      { path: "/missing" },
      { path: "/failed" },
    ];
    const sizes: Record<string, DirectorySize> = {
      "/measured": { status: "measured", sizeBytes: 8192 },
      "/missing": { status: "missing" },
      "/failed": { status: "failed", detail: "EIO" },
    };

    attachSizes(entries, sizes);

    expect(entries.map((entry) => entry.sizeBytes)).toEqual([8192, undefined, undefined]);
  });

  it("wirft bei fehlendem batch-map-eintrag (kein stilles 0)", () => {
    expect(() => attachSizes([{ path: "/x" }], {})).toThrow(/ergebnis für pfad fehlt/);
  });

  it("wirft bei unsicherer oder negativer größe", () => {
    expect(() =>
      attachSizes([{ path: "/x" }], { "/x": { status: "measured", sizeBytes: -1 } }),
    ).toThrow(/ungültige größe für pfad/);
    expect(() =>
      attachSizes([{ path: "/x" }], {
        "/x": { status: "measured", sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow(/ungültige größe für pfad/);
  });
});

describe("formatTrashErrors / combineErrors", () => {
  it("bündelt vorbereitungs- und execute-fehler getrennt und übersetzt", () => {
    setLocale("de");
    expect(formatTrashErrors([], [])).toBeNull();
    expect(formatTrashErrors(["a"], [])).toBe(
      t("cleanup.trashPrepareError", { n: 1, errors: "a" }),
    );
    expect(formatTrashErrors([], ["b"])).toBe(
      t("cleanup.trashExecuteError", { n: 1, errors: "b" }),
    );
    expect(formatTrashErrors(["a", "c"], ["b"])).toBe(
      `${t("cleanup.trashPrepareError", { n: 2, errors: "a; c" })}; ${t(
        "cleanup.trashExecuteError",
        { n: 1, errors: "b" },
      )}`,
    );
  });

  it("combineErrors verwirft leere teile", () => {
    expect(combineErrors([])).toBeNull();
    expect(combineErrors([null, null])).toBeNull();
    expect(combineErrors([null, "a", null, "b"])).toBe("a; b");
  });
});

describe("hasOrphanUnavailableBase", () => {
  const base = {
    error: null,
    orphanError: null,
    trashError: null,
    shortcutUnreadable: false,
    blockedBySkipped: false,
    pathMissingLibs: [] as string[],
    incompleteDeletionsUnreadable: [] as string[],
  };

  it("sperrt bei keinem grund nicht", () => {
    expect(hasOrphanUnavailableBase(base)).toBe(false);
    expect(hasUnreadableIncompleteDeletions(base)).toBe(false);
  });

  it("sperrt bei jedem einzelnen grund der orphan-basis", () => {
    expect(hasOrphanUnavailableBase({ ...base, error: "e" })).toBe(true);
    expect(hasOrphanUnavailableBase({ ...base, orphanError: "o" })).toBe(true);
    expect(hasOrphanUnavailableBase({ ...base, blockedBySkipped: true })).toBe(true);
    expect(hasOrphanUnavailableBase({ ...base, pathMissingLibs: ["/gone"] })).toBe(true);
    const withUnreadable = { ...base, incompleteDeletionsUnreadable: ["/x"] };
    expect(hasUnreadableIncompleteDeletions(withUnreadable)).toBe(true);
    expect(hasOrphanUnavailableBase(withUnreadable)).toBe(true);
  });

  it("trash- und shortcut-fehler sperren die orphan-basis NICHT (eigene zonen)", () => {
    // trashError fliesst nur in die legacy-erkennung ein; der papierkorb hat
    // seinen eigenen trashUnavailable-getter. gleiches gilt für shortcutUnreadable.
    expect(hasOrphanUnavailableBase({ ...base, trashError: "t" })).toBe(false);
    expect(hasOrphanUnavailableBase({ ...base, shortcutUnreadable: true })).toBe(false);
  });
});

describe("toggleInSet", () => {
  it("schaltet einen schlüssel an und wieder ab", () => {
    const set = new Set<string>();
    toggleInSet(set, "a");
    expect(set.has("a")).toBe(true);
    toggleInSet(set, "a");
    expect(set.has("a")).toBe(false);
  });
});
