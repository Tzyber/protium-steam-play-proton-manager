// T-08: die mock-preamble muss vor jedem src-/store-import geladen werden.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor den modul-importen laufen (T-08)
import { fakeScanResult, mockHttpGet, mockInstallGeProton, release } from "./protonStore.preamble";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tauriPorts } from "../../src/core/adapters/tauri";
import { setLocale } from "../../src/ui/i18n";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useProtonStore } from "../../src/ui/stores/protonStore";
import { useScanStore } from "../../src/ui/stores/scanStore";

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
    mockInstallGeProton.mockRejectedValueOnce(new Error("unavailable: install"));
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
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("de");
    useScanStore().runScan = vi.fn(async () => {});
    vi.mocked(tauriPorts.system.prepareDelete).mockReset();
    vi.mocked(tauriPorts.system.prepareDelete).mockResolvedValue({
      token: "tok-ge",
      expiresAt: Date.now() + 60000,
      targetType: "compatTool",
      targetPath: "/root/compatibilitytools.d/GE-Proton9-27",
      consequences: [],
    });
    vi.mocked(tauriPorts.system.executeDelete).mockReset();
    vi.mocked(tauriPorts.system.executeDelete).mockResolvedValue({
      deletedPath: "/root/compatibilitytools.d/GE-Proton9-27",
    });
  });

  it("reserviert vor prepareDelete und blockiert parallele GE-entfernung", async () => {
    const scan = useScanStore();
    scan.result = fakeScanResult();
    const store = useProtonStore();
    const { tauriPorts } = await import("../../src/core/adapters/tauri");
    const prepareSpy = vi.spyOn(tauriPorts.system, "prepareDelete");
    let resolvePrepare:
      | ((value: {
          token: string;
          expiresAt: number;
          targetType: "compatTool";
          targetPath: string;
          consequences: never[];
        }) => void)
      | undefined;
    prepareSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePrepare = resolve;
        }),
    );

    const firstRemove = store.remove({
      name: "GE-Proton9-27",
      internalName: "GE-Proton9-27",
      displayName: "GE-Proton9-27",
      sizeBytes: 1000,
      source: "user",
      usedBy: [],
    });
    await vi.waitFor(() => expect(prepareSpy).toHaveBeenCalledTimes(1));

    await store.remove({
      name: "GE-Proton10-1",
      internalName: "GE-Proton10-1",
      displayName: "GE-Proton10-1",
      sizeBytes: 1000,
      source: "user",
      usedBy: [],
    });

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(store.busyRemove).toBe("GE-Proton9-27");
    expect(useConfirmStore().reserved).toBe(true);

    resolvePrepare?.({
      token: "tok-ge-first",
      expiresAt: Date.now() + 60000,
      targetType: "compatTool",
      targetPath: "/root/compatibilitytools.d/GE-Proton9-27",
      consequences: [],
    });
    await firstRemove;
    expect(useConfirmStore().pending).not.toBeNull();

    useConfirmStore().cancel();
    expect(useConfirmStore().reserved).toBe(false);
    expect(store.busyRemove).toBeNull();
  });

  it("gibt die reservierung nach einem prepare-fehler frei", async () => {
    const scan = useScanStore();
    scan.result = fakeScanResult();
    vi.mocked(tauriPorts.system.prepareDelete).mockRejectedValueOnce(
      new Error("unreadable: prepare"),
    );
    const store = useProtonStore();

    await store.remove({
      name: "GE-Proton9-27",
      internalName: "GE-Proton9-27",
      displayName: "GE-Proton9-27",
      sizeBytes: 1000,
      source: "user",
      usedBy: [],
    });

    expect(useConfirmStore().reserved).toBe(false);
    expect(store.busyRemove).toBeNull();
    expect(store.loadError).toContain("unlesbar");
  });

  it("lokalisiert die steam-läuft-ablehnung beim vorbereiten", async () => {
    const scan = useScanStore();
    scan.result = fakeScanResult();
    vi.mocked(tauriPorts.system.prepareDelete).mockRejectedValueOnce(new Error("steam-running"));
    const store = useProtonStore();

    await store.remove({
      name: "GE-Proton9-27",
      internalName: "GE-Proton9-27",
      displayName: "GE-Proton9-27",
      sizeBytes: 1000,
      source: "user",
      usedBy: [],
    });

    expect(store.loadError).toContain("steam läuft");
    expect(store.busyRemove).toBeNull();
    expect(useConfirmStore().reserved).toBe(false);
  });

  it("ergänzt den prefix-satz im löschdialog", async () => {
    const scan = useScanStore();
    scan.result = fakeScanResult();
    const store = useProtonStore();

    await store.remove({
      name: "GE-Proton9-27",
      internalName: "GE-Proton9-27",
      displayName: "GE-Proton9-27",
      sizeBytes: 1000,
      source: "user",
      usedBy: [],
    });

    expect(useConfirmStore().pending?.message).toContain("Prefixes der Spiele bleiben erhalten");
    useConfirmStore().cancel();
  });

  it("löscht nur benutzerdefinierte GE-Proton Tools", async () => {
    const scan = useScanStore();
    scan.result = fakeScanResult();
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
    scan.result = fakeScanResult();
    const store = useProtonStore();
    const { tauriPorts } = await import("../../src/core/adapters/tauri");
    vi.spyOn(tauriPorts.system, "executeDelete").mockRejectedValueOnce(new Error("token-expired"));

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
    expect(store.loadError).toContain("Bestätigung ist abgelaufen");
  });
});
