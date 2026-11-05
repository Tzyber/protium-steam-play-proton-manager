// @vitest-environment happy-dom

// FR-4 (audit 4.7): OrphanPanel und TrashPanel dürfen den übergebenen
// selection-prop nicht mutieren. Sie melden die absicht als emit; der einzige
// mutator ist die CleanupView. Der test hält beide seiten fest: emit vorhanden,
// auswahl danach unverändert, lesen weiter erlaubt.

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import OrphanPanel from "../../src/ui/components/OrphanPanel.vue";
import TrashPanel from "../../src/ui/components/TrashPanel.vue";
import { useSelection } from "../../src/ui/composables/useSelection";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import { orphan as makeOrphan, trashEntry as makeTrashEntry } from "../support/factories";

describe("OrphanPanel, selection-vertrag", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("meldet einen zeilenklick als toggle-emit mit pfad und lässt die auswahl leer", async () => {
    const entry = makeOrphan(1, "shadercache", 1024);
    const selection = useSelection(() => [entry]);
    const wrapper = mount(OrphanPanel, {
      props: { kind: "shader", entries: [entry], selection },
    });

    await wrapper.get(".row").trigger("click");

    expect(wrapper.emitted("toggle")).toEqual([[entry.path]]);
    expect(selection.selected.size).toBe(0);
  });

  it("meldet den select-all-knopf als emit und schaltet die auswahl nicht selbst", async () => {
    const entry = makeOrphan(1, "shadercache", 1024);
    const selection = useSelection(() => [entry]);
    const wrapper = mount(OrphanPanel, {
      props: { kind: "shader", entries: [entry], selection },
    });
    const selectAll = wrapper.get("button.sel-all[aria-pressed]");

    await selectAll.trigger("click");

    expect(wrapper.emitted("select-all")).toHaveLength(1);
    expect(selection.selected.size).toBe(0);
    expect(selectAll.attributes("aria-pressed")).toBe("false");
  });

  it("liest die auswahl weiterhin für aria-pressed in zeile und knopf", () => {
    const entry = makeOrphan(1, "shadercache", 1024);
    const selection = useSelection(() => [entry]);
    selection.toggle(entry.path);

    const wrapper = mount(OrphanPanel, {
      props: { kind: "shader", entries: [entry], selection },
    });

    expect(wrapper.get(".row").attributes("aria-pressed")).toBe("true");
    expect(wrapper.get("button.sel-all[aria-pressed]").attributes("aria-pressed")).toBe("true");
  });
});

describe("TrashPanel, selection-vertrag", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("meldet einen zeilenklick als toggle-emit mit pfad und lässt die auswahl leer", async () => {
    const store = useCleanupStore();
    const entry = makeTrashEntry({ appId: 7, sizeBytes: 2048 });
    store.trash = [entry];
    const selection = useSelection(() => store.trash);
    const wrapper = mount(TrashPanel, { props: { selection } });

    await wrapper.get(".row").trigger("click");

    expect(wrapper.emitted("toggle")).toEqual([[entry.path]]);
    expect(selection.selected.size).toBe(0);
  });

  it("meldet den select-all-knopf als emit und schaltet die auswahl nicht selbst", async () => {
    const store = useCleanupStore();
    const entry = makeTrashEntry({ appId: 7, sizeBytes: 2048 });
    store.trash = [entry];
    const selection = useSelection(() => store.trash);
    const wrapper = mount(TrashPanel, { props: { selection } });
    const selectAll = wrapper.get("button.sel-all[aria-pressed]");

    await selectAll.trigger("click");

    expect(wrapper.emitted("select-all")).toHaveLength(1);
    expect(selection.selected.size).toBe(0);
    expect(selectAll.attributes("aria-pressed")).toBe("false");
  });

  it("liest die auswahl weiterhin für aria-pressed in zeile und knopf", () => {
    const store = useCleanupStore();
    const entry = makeTrashEntry({ appId: 7, sizeBytes: 2048 });
    store.trash = [entry];
    const selection = useSelection(() => store.trash);
    selection.toggle(entry.path);

    const wrapper = mount(TrashPanel, { props: { selection } });

    expect(wrapper.get(".row").attributes("aria-pressed")).toBe("true");
    expect(wrapper.get("button.sel-all[aria-pressed]").attributes("aria-pressed")).toBe("true");
  });
});
