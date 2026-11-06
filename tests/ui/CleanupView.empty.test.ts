// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatBytes } from "../../src/ui/format";
import { t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import CleanupView from "../../src/ui/views/CleanupView.vue";
import { orphan as makeOrphan } from "../support/factories";

describe("CleanupView incomplete deletions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("leer-zustand erscheint nicht neben fehler (unlesbarer papierkorb)", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.setTrashScanError(t("cleanup.trashUnreadable", { paths: "/lib" }));

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();
    await wrapper.get("#cv-tab-trash").trigger("click");

    expect(wrapper.text()).not.toContain(t("cleanup.trashEmptyState"));
    expect(wrapper.text()).toContain(t("cleanup.unavailable"));
    // ohne papierkorb-liste gibt es keine aktionsleiste: der sperrgrund steht
    // in den notices (FR-4).
    expect(wrapper.get("[data-testid='trash-delete-blocked-notice']").text()).toBe(
      t("cleanup.trashDeleteBlocked"),
    );
  });

  it("papierkorb-tab zeigt während der suche den ladetext statt eines leeren panels", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.trashScanning = true;

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();
    await wrapper.get("#cv-tab-trash").trigger("click");

    const panel = wrapper.get("#cv-panel-trash .empty");
    expect(panel.text()).toBe(t("cleanup.searching"));
  });

  it("leer-zustand erscheint nicht bei blockiertem scan", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.blockedBySkipped = true;
    store.orphanError = t("errors.scanIncomplete", { paths: "/lib" });

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).not.toContain(t("cleanup.empty"));
    expect(wrapper.text()).toContain(t("cleanup.unavailable"));
  });

  it("blockiert leerzustände bei path-missing und shortcutUnreadable passend zur liste", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.pathMissingLibs = ["/gone/lib"];
    store.shortcutUnreadable = true;
    store.shortcutUnreadablePaths = ["/steam/userdata/1/config/shortcuts.vdf"];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();

    expect(wrapper.get("#cv-panel-shaders").text()).not.toContain(t("cleanup.empty"));
    expect(wrapper.get("#cv-panel-shaders").text()).toContain(t("cleanup.unavailable"));
    await wrapper.get("#cv-tab-prefixes").trigger("click");
    expect(wrapper.get("#cv-panel-prefixes").text()).not.toContain(t("cleanup.empty"));
    expect(wrapper.get("#cv-panel-prefixes").text()).toContain(t("cleanup.unavailable"));

    await wrapper.get("#cv-tab-trash").trigger("click");
    expect(wrapper.get("#cv-panel-trash").text()).toContain(t("cleanup.trashEmptyState"));
  });

  it("unlesbares compatdata zeigt im prefix-tab cleanup.unavailable statt leer", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.orphanUnreadable = [{ path: "/steam/steamapps/compatdata", type: "compatdata" }];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();
    await wrapper.get("#cv-tab-prefixes").trigger("click");

    const panel = wrapper.get("#cv-panel-prefixes").text();
    expect(panel).not.toContain(t("cleanup.empty"));
    expect(panel).toContain(t("cleanup.unavailable"));
    // typ-genau (Befund 1): der shadercache-bereich bleibt lesbar und leer
    const shaderPanel = wrapper.get("#cv-panel-shaders").text();
    expect(shaderPanel).not.toContain(t("cleanup.unavailable"));
    expect(shaderPanel).toContain(t("cleanup.empty"));
  });

  it("gemischter fall: lesbarer orphan plus unlesbares verzeichnis zeigt die scan-notice", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    const unreadableDir = "/steam/steamapps/shadercache";
    const orphan = makeOrphan(4711, "compatdata");
    store.orphans = [orphan];
    store.orphanUnreadable = [{ path: unreadableDir, type: "shadercache" }];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();

    // der lesbare eintrag bleibt sichtbar …
    expect(wrapper.get("#cv-panel-shaders").text()).not.toContain(t("cleanup.empty"));
    // … und der unlesbare ort wird zusätzlich zur liste gemeldet (INV-2).
    expect(wrapper.text()).toContain(t("cleanup.unreadableDirs", { paths: unreadableDir }));
    // kein library-scan-fehler für verzeichnisse mehr (eigener key, Befund 2)
    expect(wrapper.text()).not.toContain(t("errors.scanIncomplete", { paths: unreadableDir }));
    await wrapper.get("#cv-tab-prefixes").trigger("click");
    expect(wrapper.get("#cv-panel-prefixes").text()).toContain(orphan.path);
  });

  it("papierkorb-tab: die notice der unlesbaren orphan-ordner bleibt sichtbar (akzeptierte doppelmeldung)", async () => {
    // Befund 11: die notices stehen ÜBER den drei panels, sind also nicht
    // tab-gebunden. Ein Tab-Prop müsste in CleanupView.vue verdrahtet werden;
    // die Datei liegt außerhalb dieses Korrekturauftrags. Der rein unlesbare
    // Fall zeigt deshalb die notice und zusätzlich den generischen
    // panel-zustand "ergebnis nicht verfügbar" – bewusst festgehalten, damit
    // ein späterer Umbau die Doppelmeldung nicht unbemerkt einführt/entfernt.
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    const unreadableDir = "/steam/steamapps/compatdata";
    store.orphanUnreadable = [{ path: unreadableDir, type: "compatdata" }];
    store.setTrashScanError(t("cleanup.trashUnreadable", { paths: "/lib" }));

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();
    await wrapper.get("#cv-tab-trash").trigger("click");

    expect(wrapper.text()).toContain(t("cleanup.unreadableDirs", { paths: unreadableDir }));
    expect(wrapper.get("#cv-panel-trash").text()).toContain(t("cleanup.unavailable"));
  });

  it("blockiert den trash-leerzustand bei unbekannten einträgen", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.trashUnknown = ["/steam/.protium-trash/leftover"];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();
    await wrapper.get("#cv-tab-trash").trigger("click");

    expect(wrapper.get("#cv-panel-trash").text()).not.toContain(t("cleanup.trashEmptyState"));
    expect(wrapper.get("#cv-panel-trash").text()).toContain(t("cleanup.unavailable"));
  });

  it("blockiert den passenden leerzustand bei einem unvollständigen claim", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.incompleteDeletions = [
      {
        path: "/steam/.protium-trash/.protium-delete-claim-abc",
        library: "/steam",
        type: "trash",
        name: ".protium-delete-claim-abc",
      },
    ];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();
    await wrapper.get("#cv-tab-trash").trigger("click");

    expect(wrapper.get("#cv-panel-trash").text()).not.toContain(t("cleanup.trashEmptyState"));
    expect(wrapper.get("#cv-panel-trash").text()).toContain(t("cleanup.unavailable"));
  });

  it("erfolgreicher leerer scan zeigt weiterhin den leer-zustand", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.blockedBySkipped = false;

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain(t("cleanup.empty"));
    expect(wrapper.text()).not.toContain(t("cleanup.unavailable"));
  });

  it("rendert am echten DOM '…' für verschwundene und '-' für leere größen (T-02)", async () => {
    // T-02: früher prüfte ein lokales `renderSize` nur seine eigene Kopie des
    // ternären Ausdrucks aus CleanupView.vue; ein Bruch der View blieb grün.
    // Jetzt bindet der Test die Unterscheidung an die reale Zeilenausgabe:
    // "verschwunden (…)" vs "echtes leeres verzeichnis (-)" vs gemessene größe.
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.orphans = [
      makeOrphan(1, "shadercache"),
      makeOrphan(2, "shadercache", 0),
      makeOrphan(3, "shadercache", 8192),
    ];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();

    const sizes = wrapper.findAll("#cv-panel-shaders .rsize").map((cell) => cell.text());
    expect(sizes).toContain("…");
    expect(sizes).toContain("-");
    expect(sizes).toContain(formatBytes(8192));
    expect(sizes).not.toContain("0 B");
  });
});
