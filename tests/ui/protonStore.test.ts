// T-08: die mock-preamble muss vor jedem src-/store-import geladen werden.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor den modul-importen laufen (T-08)
import {
  fakeScanResult,
  listenerCalls,
  mockCancelDownload,
  mockGeTargetArch,
  mockHttpGet,
  mockInstallGeProton,
  mockOnDownloadProgress,
  mockOnInstallPhase,
  release,
  releasesReply,
} from "./protonStore.preamble";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../src/ui/i18n";
import { useProtonStore } from "../../src/ui/stores/protonStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { deferred } from "../support/factories";
import type { HttpReply } from "./protonStore.preamble";

describe("protonStore init + pump-robustheit", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockOnDownloadProgress.mockReset();
    mockOnDownloadProgress.mockResolvedValue(() => {});
    mockOnInstallPhase.mockReset();
    mockOnInstallPhase.mockResolvedValue(() => {});
    mockGeTargetArch.mockReset();
    mockGeTargetArch.mockResolvedValue("x86_64");
    mockInstallGeProton.mockClear();
    mockCancelDownload.mockClear();
    mockHttpGet.mockClear();
  });

  it("init: listener-fehler → keine unhandled rejection, releases laden trotzdem, retry möglich", async () => {
    mockOnDownloadProgress.mockRejectedValueOnce(new Error("event api unavailable"));
    const store = useProtonStore();
    const loadReleases = vi.fn(async () => {});
    store.loadReleases = loadReleases;

    await store.init();

    expect(store.listenerReady).toBe(false);
    expect(loadReleases).toHaveBeenCalledTimes(1);
  });

  it("init: partielle listener-registrierung wird vor retry atomar bereinigt", async () => {
    const firstUnlisten = vi.fn();
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});
    mockOnDownloadProgress.mockResolvedValueOnce(firstUnlisten);
    mockOnInstallPhase.mockRejectedValueOnce(new Error("phase fehlt"));

    await store.init();

    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(store.listenerReady).toBe(false);

    mockOnDownloadProgress.mockResolvedValueOnce(vi.fn());
    mockOnInstallPhase.mockResolvedValueOnce(vi.fn());
    await store.init();

    expect(listenerCalls()).toBe(4);
    expect(store.listenerReady).toBe(true);
  });

  it("parallele init-aufrufe teilen eine registration", async () => {
    let resolveFirst: (unlisten: () => void) => void = () => {};
    let resolveSecond: (unlisten: () => void) => void = () => {};
    mockOnDownloadProgress.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mockOnInstallPhase.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveSecond = resolve;
        }),
    );
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});

    const firstInit = store.init();
    const secondInit = store.init();
    await vi.waitFor(() => expect(listenerCalls()).toBe(1));
    resolveFirst(vi.fn());
    await vi.waitFor(() => expect(listenerCalls()).toBe(2));
    resolveSecond(vi.fn());
    await Promise.all([firstInit, secondInit]);

    expect(listenerCalls()).toBe(2);
    expect(store.listenerReady).toBe(true);
  });

  it("init: erfolgreicher listener → kein erneutes listen beim zweiten aufruf", async () => {
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});

    await store.init();
    await store.init();

    expect(store.listenerReady).toBe(true);
    expect(listenerCalls()).toBe(2);
  });

  it("loadReleases: fragt die backendarchitektur vor dem fetch ab", async () => {
    const calls: string[] = [];
    mockGeTargetArch.mockImplementation(async () => {
      calls.push("arch");
      return "x86_64";
    });
    mockHttpGet.mockImplementation(async () => {
      calls.push("http");
      return { status: 200, ok: true, text: "[]", headers: {} };
    });

    const store = useProtonStore();
    await store.loadReleases();

    expect(calls).toEqual(["arch", "http"]);
    expect(mockGeTargetArch).toHaveBeenCalledTimes(1);
  });

  it("loadReleases: unbekannte oder nicht lesbare backendarchitektur stoppt fail-closed", async () => {
    mockGeTargetArch.mockRejectedValueOnce(new Error("unsupported-arch"));
    const store = useProtonStore();

    await store.loadReleases();

    expect(mockHttpGet).not.toHaveBeenCalled();
    expect(store.releases).toEqual([]);
    expect(store.loadError).toContain("Prozessorarchitektur");
  });

  it("loadReleases: eine überholte antwort überschreibt die frischeren daten nicht (U-05)", async () => {
    const older = deferred<HttpReply>();
    const newer = deferred<HttpReply>();
    mockHttpGet.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const store = useProtonStore();

    const olderRun = store.loadReleases();
    const newerRun = store.loadReleases(true);
    await vi.waitFor(() => expect(mockHttpGet).toHaveBeenCalledTimes(2));

    newer.resolve(releasesReply("GE-Proton11-5"));
    await newerRun;
    expect(store.releases.map((r) => r.tag)).toEqual(["GE-Proton11-5"]);
    expect(store.loading).toBe(false);

    // der ältere Auftrag trifft verspätet ein und darf nichts mehr schreiben
    older.resolve(releasesReply("GE-Proton11-6"));
    await olderRun;
    expect(store.releases.map((r) => r.tag)).toEqual(["GE-Proton11-5"]);
    expect(store.loading).toBe(false);
  });

  it("loadReleases: der ladezustand endet erst mit dem jüngsten auftrag (U-05)", async () => {
    const older = deferred<HttpReply>();
    const newer = deferred<HttpReply>();
    mockHttpGet.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const store = useProtonStore();

    const olderRun = store.loadReleases();
    const newerRun = store.loadReleases(true);
    await vi.waitFor(() => expect(mockHttpGet).toHaveBeenCalledTimes(2));

    older.resolve(releasesReply("GE-Proton11-6"));
    await olderRun;
    // der jüngere Auftrag lädt noch: weder Ergebnis noch Ende dürfen von ihm kommen
    expect(store.loading).toBe(true);
    expect(store.releases).toEqual([]);

    newer.resolve(releasesReply("GE-Proton11-5"));
    await newerRun;
    expect(store.loading).toBe(false);
    expect(store.releases.map((r) => r.tag)).toEqual(["GE-Proton11-5"]);
  });

  it("pump: release nicht (mehr) in der liste → job-leiche wird aufgeräumt, queue hängt nicht", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    const store = useProtonStore();
    store.releases = []; // z. B. direkt nach mount, releases noch nicht geladen

    store.queueInstall(release);
    await vi.waitFor(() => {
      expect(store.jobs[release.tag]).toBeUndefined();
    });
    expect(store.activeTag).toBeNull();

    // und der nächste gültige eintrag startet ganz normal
    store.releases = [release];
    store.queueInstall(release);
    await vi.waitFor(() => {
      expect(store.activeTag).toBe(release.tag);
    });
  });
});
