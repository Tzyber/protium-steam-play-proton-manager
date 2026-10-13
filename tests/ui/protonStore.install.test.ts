// T-08: die mock-preamble muss vor jedem src-/store-import geladen werden.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor den modul-importen laufen (T-08)
import {
  fakeScanResult,
  mockCancelDownload,
  mockHttpGet,
  mockInstallGeProton,
  mockOnDownloadProgress,
  mockOnInstallPhase,
  release,
} from "./protonStore.preamble";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../src/ui/i18n";
import { useProtonStore } from "../../src/ui/stores/protonStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import type { PhaseHandler, ProgressHandler } from "./protonStore.preamble";

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
    expect(mockInstallGeProton).toHaveBeenCalledWith(
      expect.objectContaining({ downloadId, locale: "de" }),
    );

    expect(phaseHandler).toBeDefined();
    expect(progressHandler).toBeDefined();
    phaseHandler?.({ id: downloadId ?? "", phase: "verifying", verified: false });
    expect(store.jobs[release.tag]?.phase).toBe("verifying");
    phaseHandler?.({ id: downloadId ?? "", phase: "extracting", verified: true });
    expect(store.jobs[release.tag]?.phase).toBe("extracting");
    progressHandler?.({ id: downloadId ?? "", downloaded: 42, total: 100 });
    expect(store.jobs[release.tag]?.downloaded).toBe(42);
  });

  it("gibt die aktive locale en an die installation weiter", async () => {
    setLocale("en");
    mockInstallGeProton.mockImplementationOnce(() => new Promise(() => {}));
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    const store = useProtonStore();
    store.releases = [release];
    store.queueInstall(release);

    await vi.waitFor(() => {
      expect(mockInstallGeProton).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: store.jobs[release.tag]?.downloadId, locale: "en" }),
      );
    });
  });

  it("gleiche progress-zeitstempel lassen die rate endlich", async () => {
    let progressHandler: ProgressHandler | undefined;
    mockOnDownloadProgress.mockImplementation(async (handler) => {
      progressHandler = handler;
      return () => {};
    });
    mockOnInstallPhase.mockImplementation(async () => () => {});
    mockInstallGeProton.mockImplementation(() => new Promise(() => {}));
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});
    await store.init();
    store.releases = [release];
    store.queueInstall(release);
    await vi.waitFor(() => {
      expect(store.jobs[release.tag]?.downloadId).toBeDefined();
    });
    const downloadId = store.jobs[release.tag]?.downloadId ?? "";

    // zweiter aufruf gleicher stempel wie der erste, danach ein späterer schritt.
    // die probe ohne zeitfortschritt darf weder Infinity liefern noch ihre bytes
    // verlieren: von 1_000 auf 3_000 B in 1 s sind 2_000 B/s.
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
    try {
      progressHandler?.({ id: downloadId, downloaded: 1_000, total: 4_000 });
      progressHandler?.({ id: downloadId, downloaded: 2_000, total: 4_000 });
      const speedAfterSameTimestamp = store.jobs[release.tag]?.speed;
      expect(store.jobs[release.tag]?.downloaded).toBe(2_000);
      progressHandler?.({ id: downloadId, downloaded: 3_000, total: 4_000 });
      const speed = store.jobs[release.tag]?.speed;
      expect(speedAfterSameTimestamp).toBeUndefined();
      expect(speed).toBe(2_000);
    } finally {
      nowSpy.mockRestore();
    }
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
