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
import type { HttpReply, PhaseHandler, ProgressHandler } from "./protonStore.preamble";

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

    mockOnDownloadProgress.mockResolvedValueOnce(vi.fn()).mockResolvedValueOnce(vi.fn());
    mockOnInstallPhase.mockResolvedValueOnce(vi.fn()).mockResolvedValueOnce(vi.fn());
    await store.init();

    expect(listenerCalls()).toBe(4);
    expect(store.listenerReady).toBe(true);
  });

  it("teardown: beide listener werden exakt einmal gelöst und re-init registriert neu", async () => {
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});
    mockOnDownloadProgress.mockResolvedValueOnce(firstUnlisten);
    mockOnInstallPhase.mockResolvedValueOnce(secondUnlisten);

    await store.init();
    await store.disposeListeners();
    await store.disposeListeners();

    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(secondUnlisten).toHaveBeenCalledTimes(1);
    expect(store.listenerReady).toBe(false);

    mockOnDownloadProgress.mockResolvedValueOnce(vi.fn()).mockResolvedValueOnce(vi.fn());
    mockOnInstallPhase.mockResolvedValueOnce(vi.fn()).mockResolvedValueOnce(vi.fn());
    await store.init();
    expect(listenerCalls()).toBe(4);
    expect(store.listenerReady).toBe(true);
  });

  it("$dispose löst listener und alte callback-closures wirken nicht auf recreation", async () => {
    let staleProgress: ProgressHandler | undefined;
    let stalePhase: PhaseHandler | undefined;
    const oldUnlisteners: Array<ReturnType<typeof vi.fn>> = [];
    // nur die erste registrierung ist der alte store; die des neuen stores darf
    // die gemerkten handler nicht überschreiben, sonst prüft der test nichts.
    let firstRegistration = true;
    mockOnDownloadProgress.mockImplementation(async (handler) => {
      if (firstRegistration) staleProgress = handler;
      const unlisten = vi.fn();
      oldUnlisteners.push(unlisten);
      return unlisten;
    });
    mockOnInstallPhase.mockImplementation(async (handler) => {
      if (firstRegistration) stalePhase = handler;
      firstRegistration = false;
      const unlisten = vi.fn();
      oldUnlisteners.push(unlisten);
      return unlisten;
    });
    const oldStore = useProtonStore();
    oldStore.loadReleases = vi.fn(async () => {});
    await oldStore.init();
    oldStore.$dispose();
    expect(oldUnlisteners).toHaveLength(2);
    expect(oldUnlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);

    const freshStore = useProtonStore();
    expect(freshStore).not.toBe(oldStore);
    freshStore.loadReleases = vi.fn(async () => {});
    freshStore.releases = [release];
    useScanStore().result = fakeScanResult();
    mockInstallGeProton.mockImplementation(() => new Promise(() => {}));
    await freshStore.init();
    freshStore.queueInstall(release);
    await vi.waitFor(() => {
      expect(freshStore.jobs[release.tag]?.phase).toBe("downloading");
    });

    staleProgress?.({
      id: freshStore.jobs[release.tag]?.downloadId ?? "",
      downloaded: 99,
      total: 100,
    });
    stalePhase?.({
      id: freshStore.jobs[release.tag]?.downloadId ?? "",
      phase: "extracting",
      verified: true,
    });
    expect(freshStore.jobs[release.tag]?.downloaded).toBe(0);
    expect(freshStore.jobs[release.tag]?.phase).toBe("downloading");
  });

  it("parallele init-aufrufe teilen eine registration und teardown löst beide exakt einmal", async () => {
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
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});

    const firstInit = store.init();
    const secondInit = store.init();
    await vi.waitFor(() => expect(listenerCalls()).toBe(1));
    resolveFirst(firstUnlisten);
    await vi.waitFor(() => expect(listenerCalls()).toBe(2));
    resolveSecond(secondUnlisten);
    await Promise.all([firstInit, secondInit]);
    await store.disposeListeners();

    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(secondUnlisten).toHaveBeenCalledTimes(1);
  });

  it("dispose zwischen listener-awaits verhindert spätere ownership und callbacks", async () => {
    let staleProgressForStaleTest: ProgressHandler | undefined;
    let resolveFirst: (unlisten: () => void) => void = () => {};
    let resolveSecond: (unlisten: () => void) => void = () => {};
    mockOnDownloadProgress.mockImplementation(async (handler) => {
      staleProgressForStaleTest = handler;
      return new Promise<() => void>((resolve) => {
        resolveFirst = resolve;
      });
    });
    mockOnInstallPhase.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveSecond = resolve;
        }),
    );
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});
    const initPromise = store.init();
    await vi.waitFor(() => expect(listenerCalls()).toBe(1));
    resolveFirst(firstUnlisten);
    await vi.waitFor(() => expect(listenerCalls()).toBe(2));

    const disposePromise = store.disposeListeners();
    resolveSecond(secondUnlisten);
    await Promise.all([initPromise, disposePromise]);

    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(secondUnlisten).toHaveBeenCalledTimes(1);
    expect(store.listenerReady).toBe(false);
    staleProgressForStaleTest?.({ id: "stale", downloaded: 99, total: 100 });
    expect(Object.keys(store.jobs)).toHaveLength(0);
  });

  it("dispose invalidiert init sofort und schützt einen neuen lauf vor alten resolves", async () => {
    const resolvers: Array<(unlisten: () => void) => void> = [];
    mockOnDownloadProgress.mockImplementation(
      () => new Promise<() => void>((resolve) => resolvers.push(resolve)),
    );
    mockOnInstallPhase.mockImplementation(
      () => new Promise<() => void>((resolve) => resolvers.push(resolve)),
    );
    const oldFirst = vi.fn();
    const oldSecond = vi.fn();
    const newFirst = vi.fn();
    const newSecond = vi.fn();
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});

    const oldInit = store.init();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0]?.(oldFirst);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    await store.disposeListeners();
    const newInit = store.init();
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[1]?.(oldSecond);
    resolvers[2]?.(newFirst);
    await vi.waitFor(() => expect(resolvers).toHaveLength(4));
    resolvers[3]?.(newSecond);
    await Promise.all([oldInit, newInit]);

    expect(oldFirst).toHaveBeenCalledTimes(1);
    expect(oldSecond).toHaveBeenCalledTimes(1);
    expect(store.listenerReady).toBe(true);
    await store.disposeListeners();
    expect(newFirst).toHaveBeenCalledTimes(1);
    expect(newSecond).toHaveBeenCalledTimes(1);
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

describe("protonStore pump-phasen", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockInstallGeProton.mockClear();
    mockHttpGet.mockClear();
    mockInstallGeProton.mockImplementation(() => new Promise(() => {})); // blockiert
  });

  it("phase ist 'downloading' während blockierendem installGeProton", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();

    const store = useProtonStore();
    store.releases = [release];
    store.queueInstall(release);

    await vi.waitFor(
      () => {
        expect(store.jobs[release.tag]?.phase).toBe("downloading");
      },
      { timeout: 2000 },
    );
  });

  it("abbruch während der installation fordert das backend zur bereinigung auf", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();

    mockInstallGeProton.mockResolvedValue("verified");

    const store = useProtonStore();
    store.releases = [release];
    store.queueInstall(release);

    await vi.waitFor(() => {
      expect(store.activeTag).toBe(release.tag);
    });

    const downloadId = store.jobs[release.tag]?.downloadId;
    expect(downloadId).toMatch(/^proton-[a-z0-9]+-[a-z0-9]+$/);
    expect(downloadId).not.toBe(release.tag);
    await store.cancel(release.tag);

    await vi.waitFor(() => {
      expect(store.jobs[release.tag]).toBeUndefined();
    });
    expect(mockCancelDownload).toHaveBeenCalledWith(downloadId);
    expect(store.loadError).toBeNull(); // abbruch ist kein fehler
  });

  it("verifying-/extracting-events ändern nur den passenden aktiven job", async () => {
    let phaseHandler: PhaseHandler | undefined;
    let progressHandler: ProgressHandler | undefined;
    mockOnInstallPhase.mockImplementation(async (handler) => {
      phaseHandler = handler;
      return () => {};
    });
    mockOnDownloadProgress.mockImplementation(async (handler) => {
      progressHandler = handler;
      return () => {};
    });
    mockInstallGeProton.mockImplementation(() => new Promise(() => {}));
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});
    await store.init();
    store.releases = [release];
    store.queueInstall(release);

    await vi.waitFor(() => {
      expect(store.activeTag).toBe(release.tag);
      expect(store.jobs[release.tag]?.downloadId).toBeDefined();
    });
    const downloadId = store.jobs[release.tag]?.downloadId;
    expect(downloadId).toBeDefined();
    expect(mockInstallGeProton).toHaveBeenCalledWith(expect.objectContaining({ downloadId }));

    expect(phaseHandler).toBeDefined();
    expect(progressHandler).toBeDefined();
    phaseHandler?.({ id: downloadId ?? "", phase: "verifying", verified: false });
    expect(store.jobs[release.tag]?.phase).toBe("verifying");
    phaseHandler?.({ id: downloadId ?? "", phase: "extracting", verified: true });
    expect(store.jobs[release.tag]?.phase).toBe("extracting");
    progressHandler?.({ id: downloadId ?? "", downloaded: 42, total: 100 });
    expect(store.jobs[release.tag]?.downloaded).toBe(42);
  });

  it("stale callbacks eines alten laufs ändern keinen neuen lauf desselben tags", async () => {
    let phaseHandler: PhaseHandler | undefined;
    let progressHandler: ProgressHandler | undefined;
    mockOnInstallPhase.mockImplementation(async (handler) => {
      phaseHandler = handler;
      return () => {};
    });
    mockOnDownloadProgress.mockImplementation(async (handler) => {
      progressHandler = handler;
      return () => {};
    });
    mockInstallGeProton.mockResolvedValueOnce("verified");
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    scanStore.runScan = vi.fn(async () => {});
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});
    await store.init();
    store.releases = [release];
    store.queueInstall(release);
    await vi.waitFor(() => {
      expect(store.jobs[release.tag]).toBeUndefined();
    });
    const oldDownloadId = mockInstallGeProton.mock.calls[0]?.[0]?.downloadId;
    expect(oldDownloadId).toBeDefined();

    mockInstallGeProton.mockImplementationOnce(() => new Promise(() => {}));
    store.queueInstall(release);
    await vi.waitFor(() => {
      expect(store.jobs[release.tag]?.downloadId).toBeDefined();
    });
    const newDownloadId = store.jobs[release.tag]?.downloadId;
    expect(newDownloadId).toBeDefined();
    expect(newDownloadId).not.toBe(oldDownloadId);

    // die handler des alten laufs feuern mit der alten download-id
    progressHandler?.({ id: oldDownloadId ?? "", downloaded: 99, total: 100 });
    phaseHandler?.({ id: oldDownloadId ?? "", phase: "extracting", verified: true });
    expect(store.jobs[release.tag]?.downloaded).toBe(0);
    expect(store.jobs[release.tag]?.phase).toBe("downloading");
  });

  it("bestehender zielordner → lokalisierter installExists-fehler", async () => {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    mockInstallGeProton.mockRejectedValueOnce(new Error("tool-already-exists: target directory"));

    const store = useProtonStore();
    store.releases = [release];
    store.queueInstall(release);

    await vi.waitFor(() => {
      expect(store.jobs[release.tag]).toBeUndefined();
    });
    expect(store.loadError).toContain("bereits installiert");
  });
});
