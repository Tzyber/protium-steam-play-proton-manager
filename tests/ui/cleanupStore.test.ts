// T-01: die mock-preamble liegt in tests/support/cleanupStoreMocks.ts und MUSS
// vor dem ersten store-/modul-import geladen werden, sonst baut der modulgraph
// die echten ports auf, bevor vi.mock registriert ist. Die reihenfolge weicht
// davon ab, was biome als alphabetische import-gruppierung erzwingen wuerde.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor dem store-import laufen (T-01)
import {
  fakeScan,
  mockBatchDirSizes,
  mockExecuteDelete,
  mockFindIncompleteDeletions,
  mockFindOrphans,
  mockFindSteamOwnedPrefixes,
  mockFindTrashEntries,
  mockIsSteamRunning,
  mockPrepareDelete,
  resetCleanupMocks,
} from "../support/cleanupStoreMocks";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import type { ScanResult } from "../../src/core/types";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useScanStore } from "../../src/ui/stores/scanStore";

function fakeScanWithoutCleanupSafety(): ScanResult {
  const result = fakeScan();
  Reflect.deleteProperty(result, "cleanupUnsafeLibraries");
  return result;
}

describe("cleanupStore gate logic", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de"); // assertions matchen deutsche substrings
    resetCleanupMocks();
  });

  it("blockiert wenn scope-failed library vorhanden", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "scope-failed" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/ext/lib");
    expect(store.orphans).toEqual([]);
  });

  it("blockiert wenn read-failed library vorhanden", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "read-failed" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/ext/lib");
    expect(store.orphans).toEqual([]);
  });

  it("blockiert wenn der snapshot keine unavailable-libraries belegt", async () => {
    // F1: ein snapshot ohne belegten discovery-zustand darf das cleanup nicht
    // stillschweigend freigeben.
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/home/u/.steam", reason: "unverified" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.orphans).toEqual([]);
  });

  it("bewahrt getrennte orphan- und trash-fehler beim jeweils anderen scan", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    mockFindOrphans.mockRejectedValue(new Error("unreadable"));

    await store.scanOrphans();
    expect(store.error).toContain("unlesbar");

    mockFindTrashEntries.mockResolvedValue({
      entries: [],
      unknown: [],
      unreadable: ["/home/u/.steam"],
      libraries: [],
    });
    await store.scanTrash();

    expect(store.error).toContain("unlesbar");
    expect(store.error).toContain("papierkorb");
  });

  it("verwendet während eines laufenden library-rescans keinen alten snapshot", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    scanStore.status = "scanning";
    const store = useCleanupStore();
    store.orphans = [{ appId: 1, type: "shadercache", path: "/old/shader/1", library: "/old" }];
    store.trash = [
      {
        appId: 2,
        type: "compatdata",
        path: "/old/trash/compatdata_2_1000",
        library: "/old",
        name: "compatdata_2_1000",
        trashedAt: 1000,
      },
    ];

    await store.scanOrphans();
    await store.scanTrash();

    expect(mockFindIncompleteDeletions).not.toHaveBeenCalled();
    expect(mockFindOrphans).not.toHaveBeenCalled();
    expect(mockFindTrashEntries).not.toHaveBeenCalled();
    expect(store.orphans).toEqual([]);
    expect(store.trash).toEqual([]);
  });

  it("blockiert wenn scope-failed UND path-missing libraries vorhanden", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([
      { path: "/gone/lib", reason: "path-missing" },
      { path: "/ext/lib", reason: "scope-failed" },
    ]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/ext/lib");
    expect(store.error).not.toContain("/gone/lib");
    expect(store.pathMissingLibs).toEqual([]);
  });

  it("blockiert NICHT wenn nur path-missing, zeigt stattdessen freigabe-abfrage", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(false);
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);
    expect(store.error).toBeNull();
  });

  it("meldet liegengebliebene claim-verzeichnisse als incompleteDeletions", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();

    mockFindIncompleteDeletions.mockResolvedValue({
      entries: [
        {
          path: "/home/u/.steam/steamapps/compatdata/.protium-delete-claim-123",
          library: "/home/u/.steam",
          type: "compatdata",
          name: ".protium-delete-claim-123",
        },
      ],
      unreadable: [],
    });

    await store.scanOrphans();

    expect(store.incompleteDeletions).toHaveLength(1);
    expect(store.incompleteDeletions[0]?.type).toBe("compatdata");
    expect(store.orphans).toEqual([]);
  });

  it("sucht claims vor einem blockierenden library-gate und lässt sie sichtbar", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "read-failed" }]);
    const store = useCleanupStore();
    mockFindIncompleteDeletions.mockResolvedValue({
      entries: [
        {
          path: "/home/u/.steam/steamapps/compatdata/.protium-delete-claim-123",
          library: "/home/u/.steam",
          type: "compatdata",
          name: ".protium-delete-claim-123",
        },
      ],
      unreadable: [],
    });

    await store.scanOrphans();

    expect(mockFindIncompleteDeletions).toHaveBeenCalledTimes(1);
    expect(store.incompleteDeletions).toHaveLength(1);
    expect(store.blockedBySkipped).toBe(true);
  });

  it("sucht claims auch bei laufendem steam und meldet claim-lesefehler sichtbar", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    mockIsSteamRunning.mockResolvedValue(true);
    mockFindIncompleteDeletions.mockResolvedValue({
      entries: [],
      unreadable: ["/home/u/.steam/steamapps/.protium-trash"],
    });

    await store.scanOrphans();

    expect(mockFindIncompleteDeletions).toHaveBeenCalledTimes(1);
    expect(store.incompleteDeletionsUnreadable).toEqual([
      "/home/u/.steam/steamapps/.protium-trash",
    ]);
    expect(store.error).toContain("steam läuft");
  });

  it("markiert shortcut-bereich-orphans (2^31..2^32-1) als potentialShortcut", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();

    mockFindOrphans.mockResolvedValue({
      orphans: [
        {
          appId: 3641016077,
          type: "compatdata",
          path: "/home/u/.steam/steamapps/compatdata/3641016077",
          library: "/home/u/.steam",
        },
      ],
      unreadable: [],
    });

    await store.scanOrphans();

    expect(store.orphans).toHaveLength(1);
    expect(store.orphans[0]?.potentialShortcut).toBe(true);
  });

  it("die ignorier-entscheidung überlebt einen erneuten scan (kein wiederkehrender dialog)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);

    await store.dismissPathMissing();
    expect(store.pathMissingLibs).toEqual([]);

    // ansichtswechsel: neuer store, gleicher cache
    setActivePinia(createPinia());
    const scanStore2 = useScanStore();
    scanStore2.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store2 = useCleanupStore();
    await store2.scanOrphans();

    expect(store2.pathMissingLibs).toEqual([]);
    expect(store2.ignoredMissingLibs).toEqual(["/gone/lib"]);
  });

  it("ein NEUER toter pfad fragt erneut, obwohl ein anderer ignoriert ist", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();
    await store.scanOrphans();
    await store.dismissPathMissing();

    scanStore.result = fakeScan([
      { path: "/gone/lib", reason: "path-missing" },
      { path: "/neu/weg", reason: "path-missing" },
    ]);
    await store.scanOrphans();

    // nur der unbeantwortete pfad, nicht der bereits ignorierte
    expect(store.pathMissingLibs).toEqual(["/neu/weg"]);
  });

  it("unignoreMissingLibs bringt die abfrage zurück", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();
    await store.scanOrphans();
    await store.dismissPathMissing();
    expect(store.pathMissingLibs).toEqual([]);

    await store.unignoreMissingLibs();

    expect(store.ignoredMissingLibs).toEqual([]);
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);
  });

  it("nach dismissPathMissing lauft scanOrphans durch und cleared pathMissingLibs", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/gone/lib", reason: "path-missing" }]);
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.pathMissingLibs).toEqual(["/gone/lib"]);

    store.dismissPathMissing();
    await new Promise((r) => setTimeout(r, 0));

    expect(store.pathMissingLibs).toEqual([]);
    expect(store.scanning).toBe(false);
  });

  it("deleteOrphans blockiert wenn blockedBySkipped true", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([{ path: "/ext/lib", reason: "read-failed" }]);
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.blockedBySkipped).toBe(true);

    await store.deleteOrphans([{ appId: 1, type: "compatdata", path: "/fake", library: "/lib" }]);
    expect(store.deleting.size).toBe(0);
  });

  it("gesperrte bereiche brechen nicht stumm ab, sondern nennen den unlesbaren ort (Befund 10)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    const unreadableDir = "/lib/steamapps/compatdata";
    mockFindOrphans.mockResolvedValue({
      orphans: [],
      unreadable: [{ path: unreadableDir, type: "compatdata" }],
    });

    await store.scanOrphans();
    // der scan selbst ist fehlerfrei, die sperre hängt am unlesbaren ort
    expect(store.orphanError).toBeNull();
    expect(store.orphanDeleteBlocked("compatdata")).toBe(true);

    await store.deleteOrphans([
      { appId: 999999, type: "compatdata", path: `${unreadableDir}/999999`, library: "/lib" },
    ]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(store.deleting.size).toBe(0);
    expect(store.orphanError).toBe(t("cleanup.unreadableDirs", { paths: unreadableDir }));

    // der lesbare bereich bleibt löschbar, die meldung ist keine dauersperre
    await store.deleteOrphans([
      {
        appId: 888888,
        type: "shadercache",
        path: "/lib/steamapps/shadercache/888888",
        library: "/lib",
      },
    ]);
    expect(mockPrepareDelete).toHaveBeenCalledTimes(1);
    expect(store.orphanError).toBeNull();
  });

  it("lösch- und guard-texte in orphanError kippen die typ-genaue anzeige nicht (M2)", () => {
    // `orphanError` trägt auch den Lösch-/Guard-Text des letzten versuchs. Der
    // ist kein Beleg für einen unvollständigen Scan und darf die anzeige nicht
    // auf „unlesbar“ stellen (das täte er, wenn die getter die rohe basis lesen).
    const store = useCleanupStore();

    store.orphanError = t("cleanup.unreadableDirs", { paths: "/lib/steamapps/compatdata" });
    expect(store._orphanScanError).toBeNull();
    expect(store.orphanUnreadable).toEqual([]);
    expect(store.shaderUnavailable).toBe(false);
    expect(store.prefixUnavailable).toBe(false);

    // gegenprobe: ein echter scan-fehler sperrt weiterhin beide bereiche
    store.setOrphanScanError("scan unlesbar");
    expect(store.shaderUnavailable).toBe(true);
    expect(store.prefixUnavailable).toBe(true);
  });

  it("gesperrte bereiche nennen den liegenden claim statt stumm zu bleiben (M1)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    mockFindIncompleteDeletions.mockResolvedValue({
      entries: [
        {
          path: "/lib/steamapps/compatdata/.protium-delete-claim-1",
          library: "/lib",
          type: "compatdata",
          name: ".protium-delete-claim-1",
        },
      ],
      unreadable: [],
    });

    await store.scanOrphans();
    expect(store.orphanError).toBeNull();
    expect(store.incompleteDeletions).toHaveLength(1);

    await store.deleteOrphans([
      {
        appId: 999999,
        type: "compatdata",
        path: "/lib/steamapps/compatdata/999999",
        library: "/lib",
      },
    ]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(store.deleting.size).toBe(0);
    expect(store.orphanError).not.toBeNull();
    expect(store.orphanError).toBe(t("cleanup.incompleteDeletionsTitle"));
  });

  it("unlesbare claim-parents gehen dem liegenden claim vor (M1-Reihenfolge)", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    const unreadableClaimParent = "/lib/steamapps/compatdata/.protium-delete-claims";
    mockFindIncompleteDeletions.mockResolvedValue({
      entries: [
        {
          path: "/lib/steamapps/compatdata/.protium-delete-claim-1",
          library: "/lib",
          type: "compatdata",
          name: ".protium-delete-claim-1",
        },
      ],
      unreadable: [unreadableClaimParent],
    });

    await store.scanOrphans();
    expect(store.orphanError).toBeNull();

    await store.deleteOrphans([
      {
        appId: 999999,
        type: "compatdata",
        path: "/lib/steamapps/compatdata/999999",
        library: "/lib",
      },
    ]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(store.orphanError).toBe(
      t("errors.incompleteDeletionsUnreadable", { paths: unreadableClaimParent }),
    );
  });

  it("der unlesbare ort geht unlesbaren claim-parents vor (M1-Reihenfolge)", async () => {
    // beide gründe liegen gleichzeitig vor; die meldung nennt den konkretesten
    // beleg (den ort), nicht den allgemeineren claim-lesefehler.
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    const unreadableDir = "/lib/steamapps/compatdata";
    mockFindOrphans.mockResolvedValue({
      orphans: [],
      unreadable: [{ path: unreadableDir, type: "compatdata" }],
    });
    mockFindIncompleteDeletions.mockResolvedValue({
      entries: [],
      unreadable: ["/lib/steamapps/compatdata/.protium-delete-claims"],
    });

    await store.scanOrphans();
    expect(store.orphanError).toBeNull();

    await store.deleteOrphans([
      {
        appId: 999999,
        type: "compatdata",
        path: "/lib/steamapps/compatdata/999999",
        library: "/lib",
      },
    ]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(store.orphanError).toBe(t("cleanup.unreadableDirs", { paths: unreadableDir }));
  });

  it("unlesbares shadercache sperrt die shader-einträge, aber nicht die prefixes (N9)", async () => {
    // gegenrichtung zum test oben: die sperre ist typ-genau, der prefix-bereich
    // bleibt handlungsfähig und der mock-prepare wird für compatdata gerufen.
    const scanStore = useScanStore();
    scanStore.result = fakeScan();
    const store = useCleanupStore();
    const unreadableDir = "/lib/steamapps/shadercache";
    mockFindOrphans.mockResolvedValue({
      orphans: [],
      unreadable: [{ path: unreadableDir, type: "shadercache" }],
    });

    await store.scanOrphans();
    expect(store.orphanError).toBeNull();
    expect(store.orphanDeleteBlocked("shadercache")).toBe(true);
    expect(store.orphanDeleteBlocked("compatdata")).toBe(false);

    await store.deleteOrphans([
      { appId: 888888, type: "shadercache", path: `${unreadableDir}/888888`, library: "/lib" },
    ]);

    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
    expect(store.orphanError).toBe(t("cleanup.unreadableDirs", { paths: unreadableDir }));

    await store.deleteOrphans([
      {
        appId: 999999,
        type: "compatdata",
        path: "/lib/steamapps/compatdata/999999",
        library: "/lib",
      },
    ]);

    expect(mockPrepareDelete).toHaveBeenCalledTimes(1);
    expect(store.orphanError).toBeNull();
  });

  it("blockiert scanOrphans wenn cleanupUnsafeLibraries vorhanden sind", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([], ["/unsafe/lib"]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/unsafe/lib");
    expect(store.orphans).toEqual([]);
  });

  it("blockiert deleteOrphans wenn cleanupUnsafeLibraries vorhanden sind", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([], ["/unsafe/lib"]);
    const store = useCleanupStore();

    await store.deleteOrphans([{ appId: 1, type: "compatdata", path: "/fake", library: "/lib" }]);

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("/unsafe/lib");
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
  });

  it("blockiert scanOrphans fail-closed wenn cleanupUnsafeLibraries fehlt", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanWithoutCleanupSafety();
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("Sicherheitsfeld");
    expect(mockFindOrphans).not.toHaveBeenCalled();
  });

  it("blockiert deleteOrphans fail-closed wenn cleanupUnsafeLibraries fehlt", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanWithoutCleanupSafety();
    const store = useCleanupStore();

    await store.deleteOrphans([
      { appId: 2147483647, type: "compatdata", path: "/fake", library: "/lib" },
    ]);

    expect(store.blockedBySkipped).toBe(true);
    expect(store.error).toContain("Sicherheitsfeld");
    expect(mockPrepareDelete).not.toHaveBeenCalled();
    expect(mockExecuteDelete).not.toHaveBeenCalled();
  });

  it("wenn keine skipped libraries → scan lauft normal durch", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.blockedBySkipped).toBe(false);
    expect(store.pathMissingLibs).toEqual([]);
    expect(store.error).toBeNull();
  });
});

describe("cleanupStore steamOwnedPrefixes", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    resetCleanupMocks();
  });

  it("übernimmt steam-eigene prefixes und hängt deren größen an", async () => {
    mockFindSteamOwnedPrefixes.mockResolvedValue({
      prefixes: [{ appId: 4628710, path: "/lib/compatdata/4628710", library: "/lib" }],
      unreadable: [],
    });
    mockBatchDirSizes.mockResolvedValue({
      "/lib/compatdata/4628710": { status: "measured", sizeBytes: 8192 },
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();

    expect(store.steamOwnedPrefixes).toHaveLength(1);
    expect(store.steamOwnedPrefixes[0]?.sizeBytes).toBe(8192);
    expect(mockBatchDirSizes).toHaveBeenCalledWith(["/lib/compatdata/4628710"]);
  });

  it("setzt die einträge beim nächsten scan zurück", async () => {
    mockFindSteamOwnedPrefixes.mockResolvedValue({
      prefixes: [{ appId: 4628710, path: "/lib/compatdata/4628710", library: "/lib" }],
      unreadable: [],
    });
    const scanStore = useScanStore();
    scanStore.result = fakeScan([]);
    const store = useCleanupStore();

    await store.scanOrphans();
    expect(store.steamOwnedPrefixes).toHaveLength(1);

    mockFindSteamOwnedPrefixes.mockResolvedValue({ prefixes: [], unreadable: [] });
    await store.scanOrphans();
    expect(store.steamOwnedPrefixes).toEqual([]);
  });
});
