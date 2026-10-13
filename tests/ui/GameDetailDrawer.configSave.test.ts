// @vitest-environment happy-dom

// T-08: die mock-preamble muss vor jedem src-/store-import geladen werden.
// biome-ignore assist/source/organizeImports: mock-registrierung muss vor den modul-importen laufen (T-08)
import {
  configState,
  mountDrawer,
  resetDrawerMocks,
  result,
  scanState,
  uiState,
} from "./GameDetailDrawer.preamble";
import { DOMWrapper, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { WriteResult } from "../../src/core/ports";
import type { ScanResult } from "../../src/core/types";
import { setLocale, t } from "../../src/ui/i18n";
import { deferred } from "../support/factories";

describe("GameDetailDrawer Speicherstatus", () => {
  beforeEach(() => {
    resetDrawerMocks();
    configState.saveLaunchOptions.mockReset();
    configState.saveCompatTool.mockReset();
    configState.saveLaunchOptions.mockResolvedValue("written");
    configState.saveCompatTool.mockResolvedValue("written");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setLocale("en");
  });

  function buttonNextTo(
    wrapper: ReturnType<typeof mountDrawer>,
    selector: string,
  ): DOMWrapper<HTMLButtonElement> {
    const button = wrapper.get(selector).element.parentElement?.querySelector("button");
    if (!button) throw new Error(`button next to ${selector} missing`);
    return new DOMWrapper(button);
  }

  function launchSaveButton(wrapper: ReturnType<typeof mountDrawer>) {
    return buttonNextTo(wrapper, "#launch-options");
  }

  function compatSaveButton(wrapper: ReturnType<typeof mountDrawer>) {
    return buttonNextTo(wrapper, "[data-testid='select-box']");
  }

  function compatScanResult(): ScanResult {
    const scan = result("available", "explicit", "tool-a", null, { launchOptions: "" });
    scan.compatToolsInstalled = [
      {
        name: "tool-a",
        internalName: "tool-a",
        displayName: "Tool A",
        sizeBytes: 0,
        usedBy: [],
        source: "user",
      },
      {
        name: "tool-b",
        internalName: "tool-b",
        displayName: "Tool B",
        sizeBytes: 0,
        usedBy: [],
        source: "user",
      },
    ];
    return scan;
  }

  async function selectCompatTool(
    wrapper: ReturnType<typeof mountDrawer>,
    label: string,
  ): Promise<void> {
    const option = wrapper.findAll(".select-option").find((li) => li.text() === label);
    if (!option) throw new Error(`compat option missing: ${label}`);
    await option.trigger("click");
  }

  it("führt builtin- und custom-tool mit gleichem internalName nur einmal auf (U-03)", () => {
    const scan = compatScanResult();
    scan.builtinProtonsInstalled = [{ internalName: "tool-a", displayName: "Tool A" }];
    const wrapper = mountDrawer(scan);

    const labels = wrapper.findAll(".select-option").map((li) => li.text());
    expect(labels.filter((label) => label === "Tool A")).toHaveLength(1);
    expect(labels).toContain("Tool B");
  });

  function switchToGame43(): void {
    scanState.result = result("available", "default", "default", null, {
      appId: 43,
      launchOptions: "",
    });
    uiState.selectedAppId = 43;
  }

  it("zeigt nach einem geschriebenen Startoptionen-Save den gespeichert-Status", async () => {
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("  gamemoderun %command%  ");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    expect(configState.saveLaunchOptions).toHaveBeenCalledExactlyOnceWith(
      42,
      "gamemoderun %command%",
    );
    expect(launchSaveButton(wrapper).text()).toBe(t("drawer.saved"));
  });

  it("zeigt bei unchanged kein gespeichert ✓ für die Startoptionen", async () => {
    configState.saveLaunchOptions.mockResolvedValue("unchanged");
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    expect(configState.saveLaunchOptions).toHaveBeenCalledTimes(1);
    expect(launchSaveButton(wrapper).text()).not.toBe(t("drawer.saved"));
    expect(launchSaveButton(wrapper).text()).toBe(t("drawer.save"));
  });

  it("nennt bei write-may-have-applied nicht 'nichts verändert' (Review A)", async () => {
    // Nach dem Rename ist der Abschluss offen; die Ablehnungsansicht darf dann
    // nicht den Garantiesatz des sauberen Abbruchs zeigen.
    configState.saveLaunchOptions.mockRejectedValueOnce(
      "write-may-have-applied: atomic write (parent sync): injected failure",
    );
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    const blocked = wrapper.get(".blocked-explanation");
    expect(blocked.text()).toContain(t("drawer.saveUncertain"));
    expect(blocked.text()).not.toContain(t("common.nothingChanged"));
  });

  it("bleibt beim sauberen Abbruch bei 'nichts verändert'", async () => {
    configState.saveLaunchOptions.mockRejectedValueOnce("steam-running");
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    const blocked = wrapper.get(".blocked-explanation");
    expect(blocked.text()).toContain(t("common.nothingChanged"));
    expect(blocked.text()).not.toContain(t("drawer.saveUncertain"));
  });

  it("zeigt beide speicherfehler und behält den garantiesatz nur ohne unsicheren ausgang (N-4)", async () => {
    // alter fehler: nur der erste fehler war sichtbar, und der garantiesatz
    // wurde aus ihm allein bestimmt. ein unsicherer startoptionen-write plus
    // sicherer compat-fehler zeigte fälschlich „nichts wurde verändet".
    configState.saveLaunchOptions.mockRejectedValueOnce(
      "write-may-have-applied: atomic write (parent sync): injected failure",
    );
    configState.saveCompatTool.mockRejectedValueOnce("steam-running");
    const wrapper = mountDrawer(compatScanResult());

    const input = wrapper.get<HTMLInputElement>("#launch-options");
    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    const blocked = wrapper.get(".blocked-explanation");
    expect(blocked.text()).toContain(t("errors.codes.writeMayHaveApplied"));
    expect(blocked.text()).toContain(t("errors.codes.steamRunning"));
    expect(blocked.text()).not.toContain(t("common.nothingChanged"));
    expect(blocked.text()).toContain(t("drawer.saveUncertain"));
  });

  it("verwirft ein Startoptionen-Ergebnis nach Änderung des sichtbaren Werts", async () => {
    const pending = deferred<WriteResult>();
    configState.saveLaunchOptions.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await nextTick();
    expect(configState.saveLaunchOptions).toHaveBeenCalledTimes(1);

    await input.setValue("gamemoderun %command% --später");
    pending.resolve("written");
    await flushPromises();
    await nextTick();

    expect(input.element.value).toBe("gamemoderun %command% --später");
    expect(launchSaveButton(wrapper).text()).not.toBe(t("drawer.saved"));
    // der verworfene auftrag darf den knopf nicht dauerhaft sperren
    expect(launchSaveButton(wrapper).text()).toBe(t("drawer.save"));
    expect(launchSaveButton(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("beendet den ladezustand auch bei fehler plus entwurfsänderung (N-2)", async () => {
    // alter fehler: der catch-zweig kehrte bei abweichendem entwurf zurück,
    // ohne den status zu beenden; der knopf hing dauerhaft auf "…"/gesperrt.
    const pending = deferred<WriteResult>();
    configState.saveLaunchOptions.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await nextTick();
    expect(configState.saveLaunchOptions).toHaveBeenCalledTimes(1);

    // entwurf läuft weiter, während der write hängt
    await input.setValue("gamemoderun %command% --später");
    pending.reject(new Error("steam-running"));
    await flushPromises();
    await nextTick();

    expect(launchSaveButton(wrapper).text()).toBe(t("drawer.save"));
    expect(launchSaveButton(wrapper).attributes("disabled")).toBeUndefined();
    // der gescheiterte vorgang bleibt sichtbar (U-02)
    expect(wrapper.get(".blocked-explanation").text()).toContain(t("errors.codes.steamRunning"));
  });

  it("beendet den ladezustand auch bei fehler plus entwurfsänderung am compat-tool (N-2)", async () => {
    const pending = deferred<WriteResult>();
    configState.saveCompatTool.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(compatScanResult());

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await nextTick();
    expect(configState.saveCompatTool).toHaveBeenCalledTimes(1);

    await selectCompatTool(wrapper, "Tool A");
    pending.reject(new Error("steam-running"));
    await flushPromises();
    await nextTick();

    // zurück auf den ursprungswert: der entwurf ist sauber, der knopf darf nur
    // deshalb (nicht wegen eines hängenden ladezustands) gesperrt sein.
    expect(compatSaveButton(wrapper).text()).toBe(t("drawer.save"));
    expect(compatSaveButton(wrapper).attributes("disabled")).toBeDefined();

    // ein erneut geänderter entwurf muss den knopf wieder freigeben: beim
    // alten fehlerpfad blieb `saving` stehen und der knopf dauerhaft tot (N-2).
    await selectCompatTool(wrapper, "Tool B");
    await nextTick();
    expect(compatSaveButton(wrapper).attributes("disabled")).toBeUndefined();
    expect(wrapper.get(".blocked-explanation").text()).toContain(t("errors.codes.steamRunning"));
  });

  it("verwirft die Startoptionen-Antwort nach einem Spielwechsel", async () => {
    const pending = deferred<WriteResult>();
    configState.saveLaunchOptions.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await nextTick();
    expect(configState.saveLaunchOptions).toHaveBeenCalledExactlyOnceWith(
      42,
      "gamemoderun %command%",
    );

    switchToGame43();
    await nextTick();

    pending.resolve("written");
    await flushPromises();
    await nextTick();

    expect(launchSaveButton(wrapper).text()).not.toBe(t("drawer.saved"));
    expect(launchSaveButton(wrapper).text()).toBe(t("drawer.save"));
    expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
  });

  it("zeigt nach einem Spielwechsel keinen fremden Startoptionen-Fehler", async () => {
    const pending = deferred<WriteResult>();
    configState.saveLaunchOptions.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await nextTick();

    switchToGame43();
    await nextTick();

    pending.reject(new Error("fremder Fehler 934"));
    await flushPromises();
    await nextTick();

    expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("fremder Fehler 934");
  });

  it("zeigt nach einem geschriebenen Compat-Save den gespeichert-Status", async () => {
    const wrapper = mountDrawer(compatScanResult());

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    expect(configState.saveCompatTool).toHaveBeenCalledExactlyOnceWith(42, "tool-b");
    expect(compatSaveButton(wrapper).text()).toBe(t("drawer.saved"));
  });

  it("zeigt bei unchanged kein gespeichert ✓ für das Compat-Tool", async () => {
    configState.saveCompatTool.mockResolvedValue("unchanged");
    const wrapper = mountDrawer(compatScanResult());

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();

    expect(configState.saveCompatTool).toHaveBeenCalledTimes(1);
    expect(compatSaveButton(wrapper).text()).not.toBe(t("drawer.saved"));
    expect(compatSaveButton(wrapper).text()).toBe(t("drawer.save"));
  });

  it("verwirft die Compat-Antwort nach einem Spielwechsel", async () => {
    const pending = deferred<WriteResult>();
    configState.saveCompatTool.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(compatScanResult());

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await nextTick();
    expect(configState.saveCompatTool).toHaveBeenCalledExactlyOnceWith(42, "tool-b");

    switchToGame43();
    await nextTick();

    pending.resolve("written");
    await flushPromises();
    await nextTick();

    expect(compatSaveButton(wrapper).text()).not.toBe(t("drawer.saved"));
    expect(compatSaveButton(wrapper).text()).toBe(t("drawer.save"));
    expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
  });

  it("zeigt nach einem Spielwechsel keinen fremden Compat-Fehler", async () => {
    const pending = deferred<WriteResult>();
    configState.saveCompatTool.mockReturnValueOnce(pending.promise);
    const wrapper = mountDrawer(compatScanResult());

    await selectCompatTool(wrapper, "Tool B");
    await compatSaveButton(wrapper).trigger("click");
    await nextTick();

    switchToGame43();
    await nextTick();

    pending.reject(new Error("fremder Compat-Fehler 935"));
    await flushPromises();
    await nextTick();

    expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("fremder Compat-Fehler 935");
  });

  it("hält den Fehler stehen, bis der Nutzer ihn schließt (U-02)", async () => {
    vi.useFakeTimers();
    try {
      configState.saveLaunchOptions.mockRejectedValueOnce("steam-running");
      const wrapper = mountDrawer(
        result("available", "default", "default", null, { launchOptions: "" }),
      );
      const input = wrapper.get<HTMLInputElement>("#launch-options");

      await input.setValue("gamemoderun %command%");
      await launchSaveButton(wrapper).trigger("click");
      await vi.advanceTimersByTimeAsync(7000);
      await nextTick();

      // kein auto-hide mehr: der block überlebt die frühere 6-s-grenze
      expect(wrapper.get(".blocked-explanation").text()).toContain(t("common.nothingChanged"));

      await wrapper.get("[data-testid='drawer-error-close']").trigger("click");
      expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
      expect(document.activeElement).toBe(wrapper.get(".drawer").element);
    } finally {
      vi.useRealTimers();
    }
  });

  it("behält den Entwurf bei einem Rescan derselben AppID (U-15)", async () => {
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");
    await input.setValue("gamemoderun %command%");

    // ein Rescan ersetzt den Snapshot; AppID und Bibliothek bleiben gleich
    scanState.scanGeneration = 2;
    scanState.result = result("available", "default", "default", null, { launchOptions: "" });
    await nextTick();

    expect(wrapper.get<HTMLInputElement>("#launch-options").element.value).toBe(
      "gamemoderun %command%",
    );
    expect(launchSaveButton(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("verwirft Entwurf und Fehler bei einem echten Spielwechsel (U-15)", async () => {
    configState.saveLaunchOptions.mockRejectedValueOnce("steam-running");
    const wrapper = mountDrawer(
      result("available", "default", "default", null, { launchOptions: "" }),
    );
    const input = wrapper.get<HTMLInputElement>("#launch-options");

    await input.setValue("gamemoderun %command%");
    await launchSaveButton(wrapper).trigger("click");
    await flushPromises();
    await nextTick();
    expect(wrapper.find(".blocked-explanation").exists()).toBe(true);

    switchToGame43();
    await nextTick();

    expect(wrapper.get<HTMLInputElement>("#launch-options").element.value).toBe("");
    expect(wrapper.find(".blocked-explanation").exists()).toBe(false);
  });
});
