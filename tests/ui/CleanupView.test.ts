// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrashEntry } from "../../src/core/trash";
import type { OrphanEntry } from "../../src/core/types";
import { formatBytes } from "../../src/ui/format";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import CleanupView from "../../src/ui/views/CleanupView.vue";

describe("CleanupView incomplete deletions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("zeigt exakte summen für listen, auswahl, steam-owned und papierkorb", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    const orphan = (appId: number, type: OrphanEntry["type"], sizeBytes: number): OrphanEntry => ({
      appId,
      type,
      path: `/lib/${type}/${appId}`,
      library: "/lib",
      sizeBytes,
    });
    const trash = (appId: number, sizeBytes: number): TrashEntry => ({
      appId,
      type: "compatdata",
      path: `/lib/trash/compatdata_${appId}_1000`,
      library: "/lib",
      name: `compatdata_${appId}_1000`,
      trashedAt: 1000,
      sizeBytes,
    });
    store.orphans = [
      orphan(1, "shadercache", 1024),
      orphan(2, "shadercache", 2048),
      orphan(3, "compatdata", 4096),
      orphan(4, "compatdata", 8192),
    ];
    store.steamOwnedPrefixes = [
      { appId: 5, path: "/lib/compatdata/5", library: "/lib", sizeBytes: 16384 },
      { appId: 6, path: "/lib/compatdata/6", library: "/lib", sizeBytes: 32768 },
    ];
    store.trash = [trash(7, 65536), trash(8, 131072)];
    store.trashLibraries = [{ library: "/lib", dir: "/lib/trash", present: true, count: 2 }];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();

    expect(wrapper.get("[data-testid='shader-total']").text()).toBe(
      t("cleanup.total", { size: formatBytes(3072) }),
    );
    expect(wrapper.get("[data-testid='prefix-total']").text()).toBe(
      t("cleanup.total", { size: formatBytes(12288) }),
    );
    expect(wrapper.get("[data-testid='steam-owned-total']").text()).toContain(
      t("cleanup.steamOwnedHint", { n: 2, size: formatBytes(49152) }),
    );
    expect(wrapper.get("[data-testid='trash-total']").text()).toBe(
      t("cleanup.total", { size: formatBytes(196608) }),
    );

    for (const row of wrapper.findAll("#cv-panel-shaders .row")) await row.trigger("click");
    expect(wrapper.get("[data-testid='orphan-selected-info']").text()).toBe(
      t("cleanup.selectedInfo", { n: 2, size: formatBytes(3072) }),
    );

    await wrapper.get("#cv-tab-prefixes").trigger("click");
    for (const row of wrapper.findAll("#cv-panel-prefixes .row")) await row.trigger("click");
    expect(wrapper.get("[data-testid='orphan-selected-info']").text()).toBe(
      t("cleanup.selectedInfo", { n: 2, size: formatBytes(12288) }),
    );

    await wrapper.get("#cv-tab-trash").trigger("click");
    for (const row of wrapper.findAll("#cv-panel-trash .row")) await row.trigger("click");
    expect(wrapper.get("[data-testid='trash-selected-info']").text()).toBe(
      t("cleanup.selectedInfo", { n: 2, size: formatBytes(196608) }),
    );
  });

  it("kennzeichnet exakte und teilweise größen in allen cleanup-bereichen", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    const orphan = (appId: number, type: OrphanEntry["type"], sizeBytes?: number): OrphanEntry => ({
      appId,
      type,
      path: `/lib/${type}/${appId}`,
      library: "/lib",
      sizeBytes,
    });
    const trash = (appId: number, sizeBytes?: number): TrashEntry => ({
      appId,
      type: "compatdata",
      path: `/lib/trash/compatdata_${appId}_1000`,
      library: "/lib",
      name: `compatdata_${appId}_1000`,
      trashedAt: 1000,
      sizeBytes,
    });
    store.orphans = [orphan(1, "shadercache", 1024), orphan(2, "shadercache")];
    store.orphans.push(orphan(3, "compatdata", 2048), orphan(4, "compatdata"));
    store.steamOwnedPrefixes = [
      { appId: 5, path: "/lib/compatdata/5", library: "/lib", sizeBytes: 4096 },
      { appId: 6, path: "/lib/compatdata/6", library: "/lib" },
    ];
    store.trash = [trash(7, 8192), trash(8)];
    store.trashLibraries = [{ library: "/lib", dir: "/lib/trash", present: true, count: 2 }];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();

    expect(wrapper.get("[data-testid='shader-total']").text()).toContain(
      t("cleanup.partialSize", { size: formatBytes(1024) }),
    );
    expect(wrapper.get("[data-testid='prefix-total']").text()).toContain(
      t("cleanup.partialSize", { size: formatBytes(2048) }),
    );
    expect(wrapper.get("[data-testid='steam-owned-total']").text()).toContain(
      t("cleanup.partialSize", { size: formatBytes(4096) }),
    );
    expect(wrapper.get("[data-testid='trash-total']").text()).toContain(
      t("cleanup.partialSize", { size: formatBytes(8192) }),
    );

    const shaderRows = wrapper.findAll("#cv-panel-shaders .row");
    await shaderRows[0]?.trigger("click");
    await shaderRows[1]?.trigger("click");
    expect(wrapper.get("[data-testid='orphan-selected-info']").text()).toContain(
      t("cleanup.partialSize", { size: formatBytes(1024) }),
    );

    await wrapper.get("#cv-tab-trash").trigger("click");
    const trashRows = wrapper.findAll("#cv-panel-trash .row");
    await trashRows[0]?.trigger("click");
    await trashRows[1]?.trigger("click");
    expect(wrapper.get("[data-testid='trash-selected-info']").text()).toContain(
      t("cleanup.partialSize", { size: formatBytes(8192) }),
    );
  });

  it("zeigt bei vollständig unbekannten größen nicht gemessen", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.orphans = [
      { appId: 1, type: "shadercache", path: "/shader/1", library: "/lib" },
      { appId: 2, type: "compatdata", path: "/prefix/2", library: "/lib" },
    ];
    store.steamOwnedPrefixes = [{ appId: 3, path: "/owned/3", library: "/lib" }];
    store.trash = [
      {
        appId: 4,
        type: "compatdata",
        path: "/trash/4",
        library: "/lib",
        name: "compatdata_4_1000",
        trashedAt: 1000,
      },
    ];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();

    expect(wrapper.get("[data-testid='shader-total']").text()).toContain(t("common.notMeasured"));
    expect(wrapper.get("[data-testid='prefix-total']").text()).toContain(t("common.notMeasured"));
    expect(wrapper.get("[data-testid='steam-owned-total']").text()).toContain(
      t("common.notMeasured"),
    );
    expect(wrapper.get("[data-testid='trash-total']").text()).toContain(t("common.notMeasured"));
  });

  it("sperrt destruktive aktionen während der gemeinsamen confirm-reservierung", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.orphans = [
      { appId: 1, type: "shadercache", path: "/shader/1", library: "/lib", sizeBytes: 1024 },
    ];
    store.trash = [
      {
        appId: 2,
        type: "compatdata",
        path: "/trash/2",
        library: "/lib",
        name: "compatdata_2_1000",
        trashedAt: 1000,
        sizeBytes: 1024,
      },
    ];
    const reservation = useConfirmStore().reserve();
    expect(reservation).not.toBeNull();

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();
    expect(
      wrapper
        .findAll("button.action")
        .every((button) => button.attributes("disabled") !== undefined),
    ).toBe(true);

    await wrapper.get("#cv-tab-trash").trigger("click");
    expect(
      wrapper
        .findAll("button.action")
        .every((button) => button.attributes("disabled") !== undefined),
    ).toBe(true);
  });

  it("zeigt titel, erklärung, hinweis und pfade statt internem claim-text", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.incompleteDeletions = [
      {
        path: "/steam/steamapps/compatdata/.protium-delete-claim-abc",
        library: "/steam",
        type: "compatdata",
        name: ".protium-delete-claim-abc",
      },
    ];

    const wrapper = mount(CleanupView);
    await vi.waitFor(() => expect(wrapper.text()).toContain(t("cleanup.incompleteDeletionsTitle")));

    const text = wrapper.text();
    expect(text).toContain(t("cleanup.incompleteDeletionsTitle"));
    expect(text).toContain(t("cleanup.incompleteDeletionsBody"));
    expect(text).toContain(t("cleanup.incompleteDeletionsHint"));
    expect(text).toContain(".protium-delete-claim-abc");
    expect(text).not.toContain("löschmarkierungen");
    expect(text).not.toContain("leftover deletion claims");
  });

  it("zeigt claim-lesefehler trotz steam-gate und blockiertem leerzustand", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    const unreadablePath = "/steam/steamapps/shadercache";
    store.incompleteDeletionsUnreadable = [unreadablePath];
    store.error = t("errors.steamRunningCleanup");
    store.blockedBySkipped = true;

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain(
      t("errors.incompleteDeletionsUnreadable", { paths: unreadablePath }),
    );
    expect(wrapper.text()).toContain(t("errors.steamRunningCleanup"));
    expect(wrapper.get("#cv-panel-shaders").text()).toContain(t("cleanup.unavailable"));
    expect(wrapper.get("#cv-panel-shaders").text()).not.toContain(t("cleanup.empty"));
  });

  it("holt cleanup-scans nach, wenn die view vor dem scan-ergebnis gemountet wurde", async () => {
    const store = useCleanupStore();
    const scan = useScanStore();
    scan.status = "scanning";
    scan.result = null;

    const calls: string[] = [];
    vi.spyOn(store, "scanOrphans").mockImplementation(async () => {
      calls.push("orphans");
    });
    vi.spyOn(store, "scanTrash").mockImplementation(async () => {
      calls.push("trash");
    });

    mount(CleanupView);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.error).toBeNull();
    expect(calls).toEqual([]);

    // scan liefert das ergebnis nach: der watch holt genau einmal nach
    scan.result = {
      steamRoot: "/steam",
      libraries: ["/steam"],
      games: [],
      compatToolsInstalled: [],
      builtinProtonsInstalled: [],
      defaultCompatTool: null,
      compatConfigStatus: "available",
      launchConfigStatus: "available",
      manifestCounts: { read: 0, failed: 0 },
      compatToolCounts: { read: 0, failed: 0 },
      steamUserId: null,
      warnings: [],
      skippedLibraries: [],
      cleanupUnsafeLibraries: [],
      blockedAppIds: [],
    };
    scan.status = "done";

    await vi.waitFor(() => expect(calls).toEqual(["orphans", "trash"]));
    expect(store.error).toBeNull();

    // kein endlos-watcher: weitere ticks lösen keinen weiteren scan aus
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["orphans", "trash"]);
  });

  it("verwirft den alten cleanup-snapshot während eines library-rescans und lädt danach einmal nach", async () => {
    const store = useCleanupStore();
    const scan = useScanStore();
    scan.status = "done";
    scan.scanGeneration = 1;
    scan.result = {
      steamRoot: "/old",
      libraries: ["/old"],
      games: [],
      compatToolsInstalled: [],
      builtinProtonsInstalled: [],
      defaultCompatTool: null,
      compatConfigStatus: "available",
      launchConfigStatus: "available",
      manifestCounts: { read: 0, failed: 0 },
      compatToolCounts: { read: 0, failed: 0 },
      steamUserId: null,
      warnings: [],
      skippedLibraries: [],
      cleanupUnsafeLibraries: [],
      blockedAppIds: [],
    };
    store.orphans = [
      {
        appId: 1,
        type: "shadercache",
        path: "/old/shadercache/1",
        library: "/old",
      },
    ];
    store.trash = [
      {
        appId: 2,
        type: "compatdata",
        path: "/old/.protium-trash/compatdata_2_1000",
        library: "/old",
        name: "compatdata_2_1000",
        trashedAt: 1000,
      },
    ];
    const calls: string[] = [];
    vi.spyOn(store, "scanOrphans").mockImplementation(async () => {
      calls.push("orphans");
    });
    vi.spyOn(store, "scanTrash").mockImplementation(async () => {
      calls.push("trash");
    });

    mount(CleanupView);
    await vi.waitFor(() => expect(calls).toEqual(["orphans", "trash"]));

    scan.scanGeneration = 2;
    scan.status = "scanning";
    await vi.waitFor(() => expect(store.orphans).toEqual([]));
    expect(store.trash).toEqual([]);

    scan.result = {
      ...scan.result,
      steamRoot: "/new",
      libraries: ["/new"],
    };
    scan.status = "done";
    await vi.waitFor(() => expect(calls).toEqual(["orphans", "trash", "orphans", "trash"]));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["orphans", "trash", "orphans", "trash"]);
  });

  it("leer-zustand erscheint nicht neben fehler (unlesbarer papierkorb)", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.error = t("cleanup.trashUnreadable", { paths: "/lib" });

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();
    await wrapper.get("#cv-tab-trash").trigger("click");

    expect(wrapper.text()).not.toContain(t("cleanup.trashEmptyState"));
    expect(wrapper.text()).toContain(t("cleanup.unavailable"));
  });

  it("leer-zustand erscheint nicht bei blockiertem scan", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.blockedBySkipped = true;
    store.error = t("errors.scanIncomplete", { paths: "/lib" });

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
    store.error = null;
    store.blockedBySkipped = false;

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain(t("cleanup.empty"));
    expect(wrapper.text()).not.toContain(t("cleanup.unavailable"));
  });
});

describe("CleanupView Erklärungen", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("en");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setLocale("en");
  });

  function mountView(seed: (store: ReturnType<typeof useCleanupStore>) => void) {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    seed(store);
    return mount(CleanupView, { attachTo: document.body });
  }

  function topicTriggers(wrapper: ReturnType<typeof mountView>): Map<string, Element> {
    const byLabel = new Map<string, Element>();
    for (const trigger of wrapper.findAll("[data-testid='explain-trigger']")) {
      const topic = trigger.attributes("aria-label") ?? "";
      byLabel.set(topic, trigger.element);
    }
    return byLabel;
  }

  it("erklärt steam-eigene Daten an der bestehenden Prefix-Zusammenfassung", async () => {
    const wrapper = mountView((store) => {
      store.steamOwnedPrefixes = [
        { appId: 5, path: "/lib/compatdata/5", library: "/lib", sizeBytes: 1024 },
      ];
      store.trashLibraries = [{ library: "/lib", dir: "/lib/trash", present: true, count: 0 }];
    });
    await wrapper.get("#cv-tab-prefixes").trigger("click");
    await wrapper.vm.$nextTick();

    const triggers = topicTriggers(wrapper);
    const topic = t("explain.open", { topic: t("explain.topics.steamOwned.title") });
    const trigger = triggers.get(topic);
    expect(trigger).toBeDefined();
    if (!trigger) return;
    expect(wrapper.get("[data-testid='steam-owned-total']").element.contains(trigger)).toBe(true);

    const wrapperEl = trigger as HTMLElement;
    wrapperEl.click();
    await wrapper.vm.$nextTick();
    expect(wrapper.get("[role='dialog']").text()).toContain(t("explain.topics.steamOwned.meaning"));
  });

  it("erklärt abgebrochene Löschungen an der Claim-Anzeige", async () => {
    const wrapper = mountView((store) => {
      store.incompleteDeletions = [
        {
          path: "/steam/steamapps/compatdata/.protium-delete-claim-abc",
          library: "/steam",
          type: "compatdata",
          name: ".protium-delete-claim-abc",
        },
      ];
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain(t("cleanup.incompleteDeletionsTitle")));

    const triggers = topicTriggers(wrapper);
    const topic = t("explain.open", { topic: t("explain.topics.incompleteDeletion.title") });
    expect(triggers.get(topic)).toBeDefined();
    expect(wrapper.get("#cv-panel-shaders").text()).not.toContain(t("cleanup.unavailable"));

    await wrapper.get("#cv-tab-prefixes").trigger("click");
    await wrapper.vm.$nextTick();
    expect(topicTriggers(wrapper).has(topic)).toBe(true);
    expect(wrapper.get("#cv-panel-prefixes").text()).toContain(t("cleanup.unavailable"));
  });

  it.each(["de", "en"] as const)(
    "zeigt den cleanup-blocked-topic je blockiertem Bereich in %s",
    async (locale) => {
      setLocale(locale);
      const wrapper = mountView((store) => {
        store.blockedBySkipped = true;
        store.error = t("errors.scanIncomplete", { paths: "/lib" });
      });

      const topic = t("explain.open", { topic: t("explain.topics.cleanupBlocked.title") });
      expect(wrapper.get("#cv-panel-shaders").text()).toContain(t("cleanup.unavailable"));
      expect(topicTriggers(wrapper).get(topic)).toBeDefined();

      await wrapper.get("#cv-tab-prefixes").trigger("click");
      expect(topicTriggers(wrapper).get(topic)).toBeDefined();
      await wrapper.get("#cv-tab-trash").trigger("click");
      await wrapper.vm.$nextTick();
      expect(topicTriggers(wrapper).get(topic)).toBeDefined();
      expect(wrapper.get("#cv-panel-trash").text()).toContain(t("cleanup.unavailable"));
    },
  );

  it("zeigt ohne Blockade oder Befund keinen Erklär-Trigger", async () => {
    const wrapper = mountView(() => {
      // leerer, erfolgreicher zustand
    });
    await wrapper.vm.$nextTick();
    await wrapper.get("#cv-tab-trash").trigger("click");

    expect(wrapper.findAll("[data-testid='explain-trigger']")).toHaveLength(0);
  });

  it("öffnet die Erklärung zum blockierten Bereich per Enter", async () => {
    const wrapper = mountView((store) => {
      store.blockedBySkipped = true;
      store.error = t("errors.scanIncomplete", { paths: "/lib" });
    });
    const topic = t("explain.open", { topic: t("explain.topics.cleanupBlocked.title") });
    const trigger = topicTriggers(wrapper).get(topic);
    expect(trigger).toBeDefined();
    const button = trigger as HTMLElement;

    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await wrapper.vm.$nextTick();
    const dialog = wrapper.get("[role='dialog']");
    expect(dialog.text()).toContain(t("explain.topics.cleanupBlocked.meaning"));
    expect(dialog.text()).toContain(t("explain.topics.cleanupBlocked.limit"));
    expect(dialog.attributes("aria-modal")).toBe("true");
  });
});
