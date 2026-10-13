// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatBytes } from "../../src/ui/format";
import { t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import CleanupView from "../../src/ui/views/CleanupView.vue";
import {
  orphan as makeOrphan,
  trashEntry as makeTrashEntry,
  scanResult,
} from "../support/factories";
import { buttonWithText, pressedRows, settleView, stubDeletePorts } from "./CleanupView.helpers";

describe("CleanupView incomplete deletions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("behält die orphan-auswahl beim abbruch und leert sie erst nach der bestätigung", async () => {
    const restorePorts = stubDeletePorts();
    try {
      const store = useCleanupStore();
      const entry = makeOrphan(1, "shadercache", 1024);
      // der rescan legt die zeile wieder hin. ohne clear bliebe sie ausgewählt,
      // ein verschwundener eintrag würde die leere auswahl verdecken.
      vi.spyOn(store, "scanOrphans").mockImplementation(async () => {
        store.orphans = [entry];
      });
      vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
      store.orphans = [entry];
      useScanStore().result = scanResult();

      const wrapper = mount(CleanupView);
      await wrapper.vm.$nextTick();
      await wrapper.get("#cv-panel-shaders .row").trigger("click");

      const deleteSelected = () => buttonWithText(wrapper, t("cleanup.deleteSelected", { n: 1 }));

      const firstDelete = deleteSelected();
      expect(firstDelete).toBeDefined();
      await firstDelete?.trigger("click");
      await settleView();
      expect(useConfirmStore().pending).not.toBeNull();
      expect(pressedRows(wrapper, "#cv-panel-shaders")).toEqual([true]);

      useConfirmStore().cancel();
      await settleView();
      expect(useConfirmStore().pending).toBeNull();
      expect(pressedRows(wrapper, "#cv-panel-shaders")).toEqual([true]);
      expect(wrapper.get("[data-testid='orphan-selected-info']").text()).toBe(
        t("cleanup.selectedInfo", { n: 1, size: formatBytes(1024) }),
      );

      const secondDelete = deleteSelected();
      expect(secondDelete).toBeDefined();
      expect(secondDelete?.attributes("disabled")).toBeUndefined();
      await secondDelete?.trigger("click");
      await settleView();
      expect(useConfirmStore().pending).not.toBeNull();
      expect(pressedRows(wrapper, "#cv-panel-shaders")).toEqual([true]);

      await useConfirmStore().confirm();
      await settleView();
      expect(pressedRows(wrapper, "#cv-panel-shaders")).toEqual([false]);
      expect(wrapper.get("[data-testid='orphan-selected-info']").text()).toBe(
        t("cleanup.selectedInfo", { n: 0, size: "0 B" }),
      );
    } finally {
      restorePorts();
    }
  });

  it("behält die papierkorb-auswahl beim abbruch und leert sie erst nach der bestätigung", async () => {
    const restorePorts = stubDeletePorts();
    try {
      const store = useCleanupStore();
      const entry = makeTrashEntry({ appId: 7, sizeBytes: 2048 });
      vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
      vi.spyOn(store, "scanTrash").mockImplementation(async () => {
        store.trash = [entry];
      });
      store.trash = [entry];
      useScanStore().result = scanResult();

      const wrapper = mount(CleanupView);
      await wrapper.vm.$nextTick();
      await wrapper.get("#cv-tab-trash").trigger("click");
      await wrapper.get("#cv-panel-trash .row").trigger("click");

      const deleteEntry = () => buttonWithText(wrapper, t("cleanup.trashDeleteEntry"));

      const firstDelete = deleteEntry();
      expect(firstDelete).toBeDefined();
      await firstDelete?.trigger("click");
      await settleView();
      expect(useConfirmStore().pending).not.toBeNull();
      expect(pressedRows(wrapper, "#cv-panel-trash")).toEqual([true]);

      useConfirmStore().cancel();
      await settleView();
      expect(useConfirmStore().pending).toBeNull();
      expect(pressedRows(wrapper, "#cv-panel-trash")).toEqual([true]);
      expect(wrapper.get("[data-testid='trash-selected-info']").text()).toBe(
        t("cleanup.selectedInfo", { n: 1, size: formatBytes(2048) }),
      );

      const secondDelete = deleteEntry();
      expect(secondDelete).toBeDefined();
      expect(secondDelete?.attributes("disabled")).toBeUndefined();
      await secondDelete?.trigger("click");
      await settleView();
      expect(useConfirmStore().pending).not.toBeNull();
      expect(pressedRows(wrapper, "#cv-panel-trash")).toEqual([true]);

      await useConfirmStore().confirm();
      await settleView();
      expect(pressedRows(wrapper, "#cv-panel-trash")).toEqual([false]);
      expect(wrapper.get("[data-testid='trash-selected-info']").text()).toBe(
        t("cleanup.selectedInfo", { n: 0, size: "0 B" }),
      );
    } finally {
      restorePorts();
    }
  });

  it("papierkorb leeren behält die auswahl beim abbruch und leert sie nach der bestätigung", async () => {
    const restorePorts = stubDeletePorts();
    try {
      const store = useCleanupStore();
      const entry = makeTrashEntry({ appId: 7, sizeBytes: 2048 });
      vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
      vi.spyOn(store, "scanTrash").mockImplementation(async () => {
        store.trash = [entry];
      });
      store.trash = [entry];
      useScanStore().result = scanResult();

      const wrapper = mount(CleanupView);
      await wrapper.vm.$nextTick();
      await wrapper.get("#cv-tab-trash").trigger("click");
      await wrapper.get("#cv-panel-trash .row").trigger("click");

      const emptyTrash = () => buttonWithText(wrapper, t("cleanup.trashEmpty"));

      await emptyTrash()?.trigger("click");
      await settleView();
      expect(useConfirmStore().pending).not.toBeNull();
      useConfirmStore().cancel();
      await settleView();
      expect(pressedRows(wrapper, "#cv-panel-trash")).toEqual([true]);

      await emptyTrash()?.trigger("click");
      await settleView();
      expect(useConfirmStore().pending).not.toBeNull();
      await useConfirmStore().confirm();
      await settleView();
      expect(pressedRows(wrapper, "#cv-panel-trash")).toEqual([false]);
    } finally {
      restorePorts();
    }
  });

  it("bestätigen wählt nur die im dialog gelisteten papierkorb-einträge ab", async () => {
    const confirmed = makeTrashEntry({ appId: 7, sizeBytes: 2048 });
    const failed = makeTrashEntry({ appId: 8, sizeBytes: 1024 });
    const restorePorts = stubDeletePorts(failed.path);
    try {
      const store = useCleanupStore();
      vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
      vi.spyOn(store, "scanTrash").mockImplementation(async () => {
        store.trash = [confirmed, failed];
      });
      store.trash = [confirmed, failed];
      useScanStore().result = scanResult();

      const wrapper = mount(CleanupView);
      await wrapper.vm.$nextTick();
      await wrapper.get("#cv-tab-trash").trigger("click");
      for (const row of wrapper.findAll("#cv-panel-trash .row")) await row.trigger("click");

      await buttonWithText(wrapper, t("cleanup.trashDeleteEntry"))?.trigger("click");
      await settleView();
      expect(useConfirmStore().pending).not.toBeNull();
      await useConfirmStore().confirm();
      await settleView();

      expect(pressedRows(wrapper, "#cv-panel-trash")).toEqual([false, true]);
      expect(wrapper.get("[data-testid='trash-selected-info']").text()).toBe(
        t("cleanup.selectedInfo", { n: 1, size: formatBytes(1024) }),
      );
    } finally {
      restorePorts();
    }
  });

  it("bestätigen wählt nur die im dialog gelisteten prefixe ab", async () => {
    const confirmed = makeOrphan(3, "compatdata", 4096);
    const failed = makeOrphan(4, "compatdata", 2048);
    const restorePorts = stubDeletePorts(failed.path);
    try {
      const store = useCleanupStore();
      vi.spyOn(store, "scanOrphans").mockImplementation(async () => {
        store.orphans = [confirmed, failed];
      });
      vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
      store.orphans = [confirmed, failed];
      useScanStore().result = scanResult();

      const wrapper = mount(CleanupView);
      await wrapper.vm.$nextTick();
      await wrapper.get("#cv-tab-prefixes").trigger("click");
      for (const row of wrapper.findAll("#cv-panel-prefixes .row")) await row.trigger("click");

      await buttonWithText(wrapper, t("cleanup.deleteSelected", { n: 2 }))?.trigger("click");
      await settleView();
      expect(useConfirmStore().pending).not.toBeNull();
      await useConfirmStore().confirm();
      await settleView();

      expect(pressedRows(wrapper, "#cv-panel-prefixes")).toEqual([false, true]);
      expect(wrapper.get("[data-testid='orphan-selected-info']").text()).toBe(
        t("cleanup.selectedInfo", { n: 1, size: formatBytes(2048) }),
      );
    } finally {
      restorePorts();
    }
  });

  it("bestätigen im prefix-tab behält die auswahl im shader-tab", async () => {
    const restorePorts = stubDeletePorts();
    try {
      const store = useCleanupStore();
      const shader = makeOrphan(1, "shadercache", 1024);
      const prefix = makeOrphan(2, "compatdata", 2048);
      vi.spyOn(store, "scanOrphans").mockImplementation(async () => {
        store.orphans = [shader, prefix];
      });
      vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
      store.orphans = [shader, prefix];
      useScanStore().result = scanResult();

      const wrapper = mount(CleanupView);
      await wrapper.vm.$nextTick();
      await wrapper.get("#cv-panel-shaders .row").trigger("click");
      await wrapper.get("#cv-tab-prefixes").trigger("click");
      await wrapper.get("#cv-panel-prefixes .row").trigger("click");

      await buttonWithText(wrapper, t("cleanup.deleteSelected", { n: 1 }))?.trigger("click");
      await settleView();
      expect(useConfirmStore().pending).not.toBeNull();
      await useConfirmStore().confirm();
      await settleView();

      expect(pressedRows(wrapper, "#cv-panel-prefixes")).toEqual([false]);
      expect(pressedRows(wrapper, "#cv-panel-shaders")).toEqual([true]);
    } finally {
      restorePorts();
    }
  });

  it("alle auswählen bei prefixen lässt mögliche shortcuts aus und schaltet beim zweiten klick ab", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.orphans = [
      makeOrphan(1, "compatdata", 4096),
      { ...makeOrphan(2, "compatdata", 2048), potentialShortcut: true },
    ];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();
    await wrapper.get("#cv-tab-prefixes").trigger("click");
    const selectAll = wrapper.get("#cv-panel-prefixes button.sel-all");

    await selectAll.trigger("click");
    expect(pressedRows(wrapper, "#cv-panel-prefixes")).toEqual([true, false]);
    expect(selectAll.attributes("aria-pressed")).toBe("true");

    await selectAll.trigger("click");
    expect(pressedRows(wrapper, "#cv-panel-prefixes")).toEqual([false, false]);
    expect(selectAll.attributes("aria-pressed")).toBe("false");
  });

  it("wählt orphans mit gleicher app-id in verschiedenen libraries unabhängig aus", async () => {
    const store = useCleanupStore();
    vi.spyOn(store, "scanOrphans").mockResolvedValue(undefined);
    vi.spyOn(store, "scanTrash").mockResolvedValue(undefined);
    store.orphans = [
      {
        appId: 570,
        type: "compatdata",
        path: "/lib1/steamapps/compatdata/570",
        library: "/lib1",
        sizeBytes: 2048,
      },
      {
        appId: 570,
        type: "compatdata",
        path: "/lib2/steamapps/compatdata/570",
        library: "/lib2",
        sizeBytes: 1024,
      },
    ];

    const wrapper = mount(CleanupView);
    await wrapper.vm.$nextTick();
    await wrapper.get("#cv-tab-prefixes").trigger("click");
    const rows = wrapper.findAll("#cv-panel-prefixes .row");

    await rows[1]?.trigger("click");
    expect(pressedRows(wrapper, "#cv-panel-prefixes")).toEqual([false, true]);
    await rows[0]?.trigger("click");
    await rows[1]?.trigger("click");
    expect(pressedRows(wrapper, "#cv-panel-prefixes")).toEqual([true, false]);
    expect(wrapper.get("[data-testid='orphan-selected-info']").text()).toBe(
      t("cleanup.selectedInfo", { n: 1, size: formatBytes(2048) }),
    );
  });
});
