import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeRelease } from "../../src/core/geproton";
import type { ScanResult } from "../../src/core/types";
import { setLocale } from "../../src/ui/i18n";

type Listener = (event: { payload: unknown }) => void;
type InstallCall = { downloadId: string };

const {
  mockGeTargetArch,
  mockInstallGeProton,
  mockHttpGet,
  mockListen,
  mockCancelDownload,
  registeredListeners,
} = vi.hoisted(() => ({
  mockGeTargetArch: vi.fn<() => Promise<"x86_64" | "aarch64">>(async () => "x86_64"),
  mockInstallGeProton: vi.fn<(params: InstallCall) => Promise<"verified" | "unverified">>(
    async () => "verified",
  ),
  mockCancelDownload: vi.fn(async () => {}),
  mockHttpGet: vi.fn(async () => ({
    status: 200,
    ok: true,
    text: `${"a".repeat(128)}  x.tar.gz`,
    headers: {},
  })),
  mockListen: vi.fn<(event: string, listener: Listener) => Promise<() => void>>(
    async () => () => {},
  ),
  registeredListeners: new Map<string, Listener>(),
}));

vi.mock("../../src/core/adapters/tauri", async () => {
  return {
    tauriPorts: {
      fs: {},
      http: {
        get: mockHttpGet,
      },
      system: {
        geTargetArch: mockGeTargetArch,
        installGeProton: mockInstallGeProton,
        prepareDelete: vi.fn(async (req) => ({
          token: "tok-ge",
          expiresAt: Date.now() + 60000,
          targetType: req.targetType,
          targetPath: req.path,
          consequences: [],
        })),
        executeDelete: vi.fn(async () => ({ success: true, deletedPath: "/path" })),
        cancelDownload: mockCancelDownload,
      },
      cache: {},
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useProtonStore } from "../../src/ui/stores/protonStore";
import { useScanStore } from "../../src/ui/stores/scanStore";

const release: GeRelease = {
  tag: "GE-Proton9-27",
  name: "GE-Proton9-27",
  publishedAt: "",
  notes: "",
  installName: "GE-Proton9-27",
  tarball: {
    name: "GE-Proton9-27.tar.gz",
    url: "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
    size: 400,
  },
  sha512Url:
    "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.sha512sum",
};

function fakeScanResult(): ScanResult {
  return {
    steamRoot: "/root",
    libraries: [],
    games: [],
    compatToolsInstalled: [],
    builtinProtonsInstalled: [],
    defaultCompatTool: null,
    compatConfigStatus: "available",
    steamUserId: null,
    warnings: [],
    skippedLibraries: [],
    cleanupUnsafeLibraries: [],
  };
}

describe("protonStore init + pump-robustheit", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockListen.mockReset();
    mockListen.mockResolvedValue(() => {});
    registeredListeners.clear();
    mockGeTargetArch.mockReset();
    mockGeTargetArch.mockResolvedValue("x86_64");
    mockInstallGeProton.mockClear();
    mockCancelDownload.mockClear();
    mockHttpGet.mockClear();
  });

  it("init: listener-fehler → keine unhandled rejection, releases laden trotzdem, retry möglich", async () => {
    mockListen.mockRejectedValueOnce(new Error("event api unavailable"));
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
    mockListen.mockResolvedValueOnce(firstUnlisten).mockRejectedValueOnce(new Error("phase fehlt"));

    await store.init();

    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(store.listenerReady).toBe(false);

    mockListen.mockResolvedValueOnce(vi.fn()).mockResolvedValueOnce(vi.fn());
    await store.init();

    expect(mockListen).toHaveBeenCalledTimes(4);
    expect(store.listenerReady).toBe(true);
  });

  it("teardown: beide listener werden exakt einmal gelöst und re-init registriert neu", async () => {
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});
    mockListen.mockResolvedValueOnce(firstUnlisten).mockResolvedValueOnce(secondUnlisten);

    await store.init();
    await store.disposeListeners();
    await store.disposeListeners();

    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(secondUnlisten).toHaveBeenCalledTimes(1);
    expect(store.listenerReady).toBe(false);

    mockListen.mockResolvedValueOnce(vi.fn()).mockResolvedValueOnce(vi.fn());
    await store.init();
    expect(mockListen).toHaveBeenCalledTimes(4);
    expect(store.listenerReady).toBe(true);
  });

  it("$dispose löst listener und alte callback-closures wirken nicht auf recreation", async () => {
    const oldCallbacks = new Map<string, Listener>();
    const oldUnlisteners: Array<ReturnType<typeof vi.fn>> = [];
    mockListen.mockImplementation(async (event, listener) => {
      oldCallbacks.set(event, listener);
      const unlisten = vi.fn();
      oldUnlisteners.push(unlisten);
      return unlisten;
    });
    const oldStore = useProtonStore();
    oldStore.loadReleases = vi.fn(async () => {});
    await oldStore.init();
    const staleProgress = oldCallbacks.get("download-progress");
    const stalePhase = oldCallbacks.get("install-phase");
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
      payload: { id: freshStore.jobs[release.tag]?.downloadId, downloaded: 99, total: 100 },
    });
    stalePhase?.({
      payload: {
        id: freshStore.jobs[release.tag]?.downloadId,
        phase: "extracting",
        verified: true,
      },
    });
    expect(freshStore.jobs[release.tag]?.downloaded).toBe(0);
    expect(freshStore.jobs[release.tag]?.phase).toBe("downloading");
  });

  it("parallele init-aufrufe teilen eine registration und teardown löst beide exakt einmal", async () => {
    let resolveFirst: (unlisten: () => void) => void = () => {};
    let resolveSecond: (unlisten: () => void) => void = () => {};
    mockListen.mockImplementation((event) => {
      return new Promise<() => void>((resolve) => {
        if (event === "download-progress") resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});

    const firstInit = store.init();
    const secondInit = store.init();
    await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1));
    resolveFirst(firstUnlisten);
    await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(2));
    resolveSecond(secondUnlisten);
    await Promise.all([firstInit, secondInit]);
    await store.disposeListeners();

    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(secondUnlisten).toHaveBeenCalledTimes(1);
  });

  it("dispose zwischen listener-awaits verhindert spätere ownership und callbacks", async () => {
    let resolveFirst: (unlisten: () => void) => void = () => {};
    let resolveSecond: (unlisten: () => void) => void = () => {};
    const callbacks = new Map<string, Listener>();
    mockListen.mockImplementation((event, listener) => {
      callbacks.set(event, listener);
      return new Promise<() => void>((resolve) => {
        if (event === "download-progress") resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    const store = useProtonStore();
    store.loadReleases = vi.fn(async () => {});
    const initPromise = store.init();
    await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1));
    resolveFirst(firstUnlisten);
    await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(2));

    const disposePromise = store.disposeListeners();
    resolveSecond(secondUnlisten);
    await Promise.all([initPromise, disposePromise]);

    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(secondUnlisten).toHaveBeenCalledTimes(1);
    expect(store.listenerReady).toBe(false);
    callbacks.get("download-progress")?.({
      payload: { id: "stale", downloaded: 99, total: 100 },
    });
    expect(Object.keys(store.jobs)).toHaveLength(0);
  });

  it("dispose invalidiert init sofort und schützt einen neuen lauf vor alten resolves", async () => {
    const resolvers: Array<(unlisten: () => void) => void> = [];
    mockListen.mockImplementation(async () => {
      return new Promise<() => void>((resolve) => resolvers.push(resolve));
    });
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
    expect(mockListen).toHaveBeenCalledTimes(2);
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
    mockGeTargetArch.mockRejectedValueOnce(new Error("unsupported target architecture"));
    const store = useProtonStore();

    await store.loadReleases();

    expect(mockHttpGet).not.toHaveBeenCalled();
    expect(store.releases).toEqual([]);
    expect(store.loadError).toContain("unsupported target architecture");
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
    mockListen.mockImplementation(async (event, listener) => {
      registeredListeners.set(event, listener);
      return () => registeredListeners.delete(event);
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

    const phaseListener = registeredListeners.get("install-phase");
    const progressListener = registeredListeners.get("download-progress");
    expect(phaseListener).toBeDefined();
    expect(progressListener).toBeDefined();
    phaseListener?.({ payload: { id: downloadId, phase: "verifying", verified: false } });
    expect(store.jobs[release.tag]?.phase).toBe("verifying");
    phaseListener?.({ payload: { id: downloadId, phase: "extracting", verified: true } });
    expect(store.jobs[release.tag]?.phase).toBe("extracting");
    progressListener?.({ payload: { id: downloadId, downloaded: 42, total: 100 } });
    expect(store.jobs[release.tag]?.downloaded).toBe(42);
  });

  it("stale callbacks eines alten laufs ändern keinen neuen lauf desselben tags", async () => {
    mockListen.mockImplementation(async (event, listener) => {
      registeredListeners.set(event, listener);
      return () => registeredListeners.delete(event);
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

    registeredListeners.get("download-progress")?.({
      payload: { id: oldDownloadId, downloaded: 99, total: 100 },
    });
    registeredListeners.get("install-phase")?.({
      payload: { id: oldDownloadId, phase: "extracting", verified: true },
    });
    expect(store.jobs[release.tag]?.downloaded).toBe(0);
    expect(store.jobs[release.tag]?.phase).toBe("downloading");
  });
});

describe("protonStore warnung (sha512-fetch-fehler)", () => {
  const withSha = {
    ...release,
    sha512Url:
      "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.sha512sum",
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    mockInstallGeProton.mockClear();
    mockHttpGet.mockReset();
    mockHttpGet.mockResolvedValue({
      status: 200,
      ok: true,
      text: `${"a".repeat(128)}  x.tar.gz`,
      headers: {},
    });
    mockInstallGeProton.mockResolvedValue("verified");
  });

  function installWithSha() {
    const scanStore = useScanStore();
    scanStore.result = fakeScanResult();
    scanStore.runScan = vi.fn(async () => {});
    const store = useProtonStore();
    store.releases = [withSha];
    return store;
  }

  it("clearWarning entfernt die warnung (wegklickbar über das ×)", () => {
    const store = installWithSha();
    store.warning = { tag: withSha.tag, msg: "alte warnung" };
    store.clearWarning();
    expect(store.warning).toBeNull();
  });

  it("unverified-ergebnis → warning mit tag gesetzt", async () => {
    mockInstallGeProton.mockResolvedValueOnce("unverified");
    const store = installWithSha();

    store.queueInstall(withSha);

    await vi.waitFor(() => {
      expect(store.jobs[withSha.tag]).toBeUndefined();
    });
    expect(store.warning).toEqual({
      tag: withSha.tag,
      msg: "GE-Proton9-27 ohne Verifikation installiert (Prüfsumme nicht abrufbar)",
    });
  });

  it("verifizierter reinstall desselben tags räumt alte warnung + loadError", async () => {
    mockInstallGeProton.mockResolvedValueOnce("verified");
    const store = installWithSha();
    store.warning = { tag: withSha.tag, msg: "alte warnung" };
    store.loadError = "alter fehler";

    store.queueInstall(withSha);

    await vi.waitFor(() => {
      expect(store.jobs[withSha.tag]).toBeUndefined();
    });
    expect(store.warning).toBeNull();
    expect(store.loadError).toBeNull();
  });

  it("install-fail → keine warning neben loadError", async () => {
    mockInstallGeProton.mockRejectedValueOnce(new Error("install kaputt"));
    const store = installWithSha();

    store.queueInstall(withSha);

    await vi.waitFor(() => {
      expect(store.jobs[withSha.tag]).toBeUndefined();
    });
    expect(store.warning).toBeNull();
    expect(store.loadError).not.toBeNull();
  });
});

describe("protonStore.remove", () => {
  it("löscht nur benutzerdefinierte GE-Proton Tools", async () => {
    const scan = useScanStore();
    scan.result = {
      steamRoot: "/root",
      libraries: [],
      games: [],
      compatToolsInstalled: [],
      builtinProtonsInstalled: [],
      defaultCompatTool: null,
      compatConfigStatus: "available",
      steamUserId: null,
      warnings: [],
      skippedLibraries: [],
      cleanupUnsafeLibraries: [],
    };
    const store = useProtonStore();
    const { tauriPorts } = await import("../../src/core/adapters/tauri");
    const prepareSpy = vi.spyOn(tauriPorts.system, "prepareDelete");
    const executeSpy = vi.spyOn(tauriPorts.system, "executeDelete");

    await store.remove({
      name: "GE-Proton9-27",
      internalName: "GE-Proton9-27",
      displayName: "GE-Proton9-27",
      sizeBytes: 1000,
      source: "user",
      usedBy: [],
    });
    // der dialog wartet auf die bestätigung; erst der klick führt das löschen aus
    await useConfirmStore().confirm();
    expect(prepareSpy).toHaveBeenCalledWith({
      targetType: "compatTool",
      path: "/root/compatibilitytools.d/GE-Proton9-27",
      steamRoot: "/root",
    });
    expect(executeSpy).toHaveBeenCalledWith("tok-ge");

    prepareSpy.mockClear();
    executeSpy.mockClear();
    await store.remove({
      name: "Proton-Custom",
      internalName: "Proton-Custom",
      displayName: "Proton-Custom",
      sizeBytes: 1000,
      source: "user",
      usedBy: [],
    });
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();

    await store.remove({
      name: "GE-Proton9-27",
      internalName: "GE-Proton9-27",
      displayName: "GE-Proton9-27",
      sizeBytes: 1000,
      source: "system",
      usedBy: [],
    });
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("onError räumt busyRemove nach execute-fehler auf", async () => {
    const scan = useScanStore();
    scan.result = {
      steamRoot: "/root",
      libraries: [],
      games: [],
      compatToolsInstalled: [],
      builtinProtonsInstalled: [],
      defaultCompatTool: null,
      compatConfigStatus: "available",
      steamUserId: null,
      warnings: [],
      skippedLibraries: [],
      cleanupUnsafeLibraries: [],
    };
    const store = useProtonStore();
    const { tauriPorts } = await import("../../src/core/adapters/tauri");
    vi.spyOn(tauriPorts.system, "executeDelete").mockRejectedValueOnce(new Error("token expired"));

    await store.remove({
      name: "GE-Proton9-27",
      internalName: "GE-Proton9-27",
      displayName: "GE-Proton9-27",
      sizeBytes: 1000,
      source: "user",
      usedBy: [],
    });
    await useConfirmStore().confirm();

    expect(store.busyRemove).toBeNull();
    expect(store.loadError).toContain("token expired");
  });
});
