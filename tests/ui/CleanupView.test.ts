// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrashEntry } from "../../src/core/trash";
import type { OrphanEntry } from "../../src/core/types";
import { formatBytes } from "../../src/ui/format";
import { t } from "../../src/ui/i18n";
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

  it("holt cleanup-scans nach, wenn die view vor dem scan-ergebnis gemountet wurde", async () => {
    const store = useCleanupStore();
    const scan = useScanStore();
    scan.status = "scanning";
    scan.result = null;

    const calls: string[] = [];
    vi.spyOn(store, "scanOrphans").mockImplementation(async () => {
      calls.push("orphans");
      // spiegelt den store-early-return: ohne ergebnis steht der fehler
      store.error = scan.result ? null : t("errors.noScanResult");
    });
    vi.spyOn(store, "scanTrash").mockImplementation(async () => {
      calls.push("trash");
    });

    mount(CleanupView);
    await vi.waitFor(() => expect(store.error).toBe(t("errors.noScanResult")));
    expect(calls.filter((c) => c === "orphans")).toHaveLength(1);

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

    await vi.waitFor(() => expect(store.error).toBeNull());
    expect(calls.filter((c) => c === "orphans")).toHaveLength(2);
    expect(calls.filter((c) => c === "trash")).toHaveLength(2);

    // kein endlos-watcher: weitere ticks lösen keinen weiteren scan aus
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((c) => c === "orphans")).toHaveLength(2);
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
