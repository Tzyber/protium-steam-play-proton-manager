import { afterEach, describe, expect, it } from "vitest";
import type { IncompleteDeletion, OrphanUnreadable } from "../../src/core/cleanup";
import type { DirectorySize } from "../../src/core/ports";
import type { ShortcutResult } from "../../src/core/shortcuts";
import type { TrashLibraryStatus } from "../../src/core/trash";
import type { ScanResult } from "../../src/core/types";
import { setLocale, t } from "../../src/ui/i18n";
import {
  attachSizes,
  cleanupBlockedFlags,
  collectInstalledAppIds,
  combineErrors,
  formatTrashErrors,
  hasOrphanUnavailableBase,
  hasUnreadableOrphanType,
  isCurrentForScan,
  mergeOrphanUnreadable,
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

  it("nimmt spiele und bei lesbaren shortcuts auch deren ids", () => {
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
    orphanError: null,
    blockedBySkipped: false,
    pathMissingLibs: [] as string[],
    incompleteDeletionsUnreadable: [] as string[],
  };

  it("sperrt bei keinem grund nicht", () => {
    expect(hasOrphanUnavailableBase(base)).toBe(false);
  });

  it("sperrt bei jedem einzelnen grund der orphan-basis", () => {
    expect(hasOrphanUnavailableBase({ ...base, orphanError: "o" })).toBe(true);
    expect(hasOrphanUnavailableBase({ ...base, blockedBySkipped: true })).toBe(true);
    expect(hasOrphanUnavailableBase({ ...base, pathMissingLibs: ["/gone"] })).toBe(true);
    expect(hasOrphanUnavailableBase({ ...base, incompleteDeletionsUnreadable: ["/x"] })).toBe(true);
  });

  it("die unlesbaren orphan-ordner sind keine Basis, sondern typ-genau", () => {
    // Bewusste Grenze: ein unlesbares compatdata darf den shadercache nicht
    // sperren. Die Basis bleibt deshalb bei den bereichsübergreifenden Gründen.
    const state = {
      ...base,
      orphanUnreadable: [{ path: "/lib/steamapps/compatdata", type: "compatdata" as const }],
    };
    expect(hasOrphanUnavailableBase(state)).toBe(false);
    expect(hasUnreadableOrphanType(state, "compatdata")).toBe(true);
    expect(hasUnreadableOrphanType(state, "shadercache")).toBe(false);
  });
});

describe("hasUnreadableOrphanType", () => {
  const state = {
    orphanUnreadable: [
      { path: "/lib/steamapps/compatdata", type: "compatdata" as const },
      { path: "/lib2/steamapps/shadercache", type: "shadercache" as const },
      { path: "/lib3/steamapps/compatdata", type: "compatdata" as const },
    ],
  };

  it("prüft genau den übergebenen bereich", () => {
    expect(hasUnreadableOrphanType(state, "compatdata")).toBe(true);
    expect(hasUnreadableOrphanType(state, "shadercache")).toBe(true);
  });

  it("sperrt einen bereich nicht ohne beleg", () => {
    const onlyShader = {
      orphanUnreadable: [{ path: "/lib/steamapps/shadercache", type: "shadercache" as const }],
    };
    expect(hasUnreadableOrphanType(onlyShader, "compatdata")).toBe(false);
    expect(hasUnreadableOrphanType({ orphanUnreadable: [] }, "compatdata")).toBe(false);
  });
});

describe("cleanupBlockedFlags", () => {
  const facts = {
    orphanScanError: null as string | null,
    blockedBySkipped: false,
    pathMissingLibs: [] as string[],
    incompleteDeletionsUnreadable: [] as string[],
    shortcutUnreadable: false,
    orphanUnreadable: [] as OrphanUnreadable[],
    incompleteDeletions: [] as { type: IncompleteDeletion["type"] }[],
    trashScanError: null as string | null,
    trashUnknown: [] as string[],
    trashLibraries: [] as TrashLibraryStatus[],
  };

  it("sperrt ohne grund nichts", () => {
    expect(cleanupBlockedFlags(facts)).toEqual({
      base: false,
      shader: false,
      prefix: false,
      trash: false,
      trashDelete: false,
      any: false,
    });
  });

  it("jeder basisgrund sperrt shader und prefix", () => {
    const reasons = [
      { orphanScanError: "scan unlesbar" },
      { blockedBySkipped: true },
      { pathMissingLibs: ["/gone"] },
    ];
    for (const reason of reasons) {
      const flags = cleanupBlockedFlags({ ...facts, ...reason });
      expect(flags.base).toBe(true);
      expect(flags.shader).toBe(true);
      expect(flags.prefix).toBe(true);
      expect(flags.any).toBe(true);
      // der papierkorb bleibt bei diesen gründen handlungsfähig
      expect(flags.trash).toBe(false);
      expect(flags.trashDelete).toBe(false);
    }
  });

  it("unlesbare claim-parents sperren basis, shader, prefix und papierkorb", () => {
    const flags = cleanupBlockedFlags({ ...facts, incompleteDeletionsUnreadable: ["/x"] });

    expect(flags).toEqual({
      base: true,
      shader: true,
      prefix: true,
      trash: true,
      trashDelete: true,
      any: true,
    });
  });

  it("die unlesbaren orphan-ordner sperren typ-genau, nicht die basis", () => {
    const shader = cleanupBlockedFlags({
      ...facts,
      orphanUnreadable: [{ path: "/lib/steamapps/shadercache", type: "shadercache" }],
    });
    expect(shader).toEqual({
      base: false,
      shader: true,
      prefix: false,
      trash: false,
      trashDelete: false,
      any: true,
    });

    const prefix = cleanupBlockedFlags({
      ...facts,
      orphanUnreadable: [{ path: "/lib/steamapps/compatdata", type: "compatdata" }],
    });
    expect(prefix).toEqual({
      base: false,
      shader: false,
      prefix: true,
      trash: false,
      trashDelete: false,
      any: true,
    });
  });

  it("der shortcut-lesefehler sperrt nur den prefix-bereich", () => {
    expect(cleanupBlockedFlags({ ...facts, shortcutUnreadable: true })).toEqual({
      base: false,
      shader: false,
      prefix: true,
      trash: false,
      trashDelete: false,
      any: true,
    });
  });

  it("liegengebliebene claims sperren typ-genau, nicht die basis", () => {
    expect(
      cleanupBlockedFlags({ ...facts, incompleteDeletions: [{ type: "shadercache" }] }),
    ).toEqual({
      base: false,
      shader: true,
      prefix: false,
      trash: false,
      trashDelete: false,
      any: true,
    });
    expect(
      cleanupBlockedFlags({ ...facts, incompleteDeletions: [{ type: "compatdata" }] }),
    ).toEqual({
      base: false,
      shader: false,
      prefix: true,
      trash: false,
      trashDelete: false,
      any: true,
    });
    expect(cleanupBlockedFlags({ ...facts, incompleteDeletions: [{ type: "trash" }] })).toEqual({
      base: false,
      shader: false,
      prefix: false,
      trash: true,
      trashDelete: true,
      any: true,
    });
    // compat-tool-reste sperren keinen der bereiche
    expect(
      cleanupBlockedFlags({ ...facts, incompleteDeletions: [{ type: "compat-tool" }] }),
    ).toEqual({
      base: false,
      shader: false,
      prefix: false,
      trash: false,
      trashDelete: false,
      any: false,
    });
  });

  it("der papierkorb sperrt nur sich selbst", () => {
    const reasons = [
      { facts: { trashScanError: "kaputt" }, trashDelete: true },
      { facts: { trashUnknown: ["/lib/unknown"] }, trashDelete: false },
      {
        facts: {
          trashLibraries: [
            { library: "/lib", dir: "/lib/trash", present: true, count: 0, error: "unreadable" },
          ],
        },
        trashDelete: true,
      },
    ];
    for (const reason of reasons) {
      expect(cleanupBlockedFlags({ ...facts, ...reason.facts })).toEqual({
        base: false,
        shader: false,
        prefix: false,
        trash: true,
        trashDelete: reason.trashDelete,
        any: true,
      });
    }

    // ein lesbarer, leerer papierkorb sperrt nicht
    expect(
      cleanupBlockedFlags({
        ...facts,
        trashLibraries: [{ library: "/lib", dir: "/lib/trash", present: false, count: 0 }],
      }).trash,
    ).toBe(false);
  });

  it("trashDelete sperrt ohne trashUnknown, aber mit jedem scan- und rest-beleg", () => {
    // ein unbekannter papierkorb-eintrag ist ein anzeigeproblem (er wird nicht
    // angeboten), kein beleg für einen unvollständigen scan: das löschen der
    // erkannten einträge bleibt möglich (FR-4).
    const unknown = cleanupBlockedFlags({ ...facts, trashUnknown: ["/lib/unknown"] });
    expect(unknown.trash).toBe(true);
    expect(unknown.trashDelete).toBe(false);

    const blocking = [
      { trashScanError: "papierkorb-scan fehlgeschlagen" },
      {
        trashLibraries: [
          { library: "/lib", dir: "/lib/trash", present: true, count: 0, error: "unreadable" },
        ],
      },
      { incompleteDeletionsUnreadable: ["/lib/steamapps"] },
      { incompleteDeletions: [{ type: "trash" as const }] },
    ];
    for (const reason of blocking) {
      const flags = cleanupBlockedFlags({ ...facts, ...reason });
      expect(flags.trash).toBe(true);
      expect(flags.trashDelete).toBe(true);
    }

    expect(cleanupBlockedFlags(facts).trashDelete).toBe(false);
  });
});

describe("mergeOrphanUnreadable", () => {
  const compat = { path: "/lib/steamapps/compatdata", type: "compatdata" as const };
  const shader = { path: "/lib/steamapps/shadercache", type: "shadercache" as const };

  it("führt die listen zusammen und dedupliziert nach pfad und typ", () => {
    expect(mergeOrphanUnreadable([compat], [compat, shader])).toEqual([compat, shader]);
    expect(mergeOrphanUnreadable([], [])).toEqual([]);
  });

  it("behandelt denselben pfad mit unterschiedlichem typ als zwei befunde", () => {
    const samepath = { path: "/lib/x", type: "shadercache" as const };
    expect(mergeOrphanUnreadable([{ ...compat, path: "/lib/x" }], [samepath])).toEqual([
      { path: "/lib/x", type: "compatdata" },
      samepath,
    ]);
  });

  it("behält die reihenfolge des ersten vorkommens", () => {
    expect(mergeOrphanUnreadable([shader], [compat, shader])).toEqual([shader, compat]);
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
