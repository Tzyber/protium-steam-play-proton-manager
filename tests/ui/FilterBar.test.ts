// @vitest-environment happy-dom

import { type DOMWrapper, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import type { ScanResult } from "../../src/core/types";
import FilterBar from "../../src/ui/components/FilterBar.vue";
import { setLocale, t } from "../../src/ui/i18n";
import { useLibraryStore } from "../../src/ui/stores/libraryStore";
import { useScanStore } from "../../src/ui/stores/scanStore";
import { game, scanResult } from "../support/factories";

function result(): ScanResult {
  return scanResult({
    games: [
      game({ appId: 42, protonDb: { tier: "bronze", confidence: "strong" } }),
      // zweite library und zweites tool: sonst rendert die leiste die
      // chip-gruppen gar nicht, und der aria-pressed-vergleich hätte kein ziel.
      game({ appId: 43, library: "/steam/library", compatTool: "proton_9" }),
    ],
    defaultCompatTool: "proton_experimental",
  });
}

function sortRadio(radios: DOMWrapper<Element>[], label: string): DOMWrapper<Element> {
  const found = radios.find((radio) => radio.text().includes(label));
  if (!found) throw new Error(`kein sortierknopf für ${label}`);
  return found;
}

function keydown(element: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

describe("FilterBar proton-check", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("en");
    useScanStore().result = result();
  });

  afterEach(() => setLocale("en"));

  it("zeigt einen zugänglichen proton-check-button mit pressed-state", async () => {
    const wrapper = mount(FilterBar);
    const button = wrapper.get("button.proton-check");

    expect(button.attributes("aria-label")).toBe(t("filter.protonCheckAria"));
    expect(button.attributes("aria-pressed")).toBe("false");
    expect(button.text()).toContain(t("filter.protonCheck"));

    await button.trigger("click");

    expect(button.attributes("aria-pressed")).toBe("true");
    expect(useLibraryStore().protonCheck).toBe(true);
  });

  it("zeigt die beschriftete suche und leert sie über den clear-button", async () => {
    const lib = useLibraryStore();
    const wrapper = mount(FilterBar);
    const input = wrapper.get("input#library-search");

    expect(wrapper.get('label[for="library-search"]').text()).toBe(t("filter.search"));

    await input.setValue("test");

    const clear = wrapper.get("button.clear");
    expect(clear.attributes("aria-label")).toBe(t("filter.searchClear"));

    await clear.trigger("click");

    expect(lib.search).toBe("");
    expect(wrapper.find("button.clear").exists()).toBe(false);
  });

  it("reset setzt den aktiven proton-check zurück", async () => {
    const lib = useLibraryStore();
    lib.protonCheck = true;
    const wrapper = mount(FilterBar);

    await wrapper.get("button.reset").trigger("click");

    expect(lib.protonCheck).toBe(false);
    expect(wrapper.get("button.proton-check").attributes("aria-pressed")).toBe("false");
  });

  it("zyklisiert die quelle der proton-zuordnung und nennt den zustand", async () => {
    const lib = useLibraryStore();
    const wrapper = mount(FilterBar);
    const button = wrapper.get("button.compat-source");

    expect(button.text()).toContain(t("filter.compatSourceAll"));
    expect(button.attributes("aria-pressed")).toBe("false");

    await button.trigger("click");
    expect(lib.compatSource).toBe("unavailable");
    expect(button.text()).toContain(t("filter.compatSourceUnavailable"));
    expect(button.attributes("aria-pressed")).toBe("true");

    await button.trigger("click");
    expect(lib.compatSource).toBe("default");
    expect(button.text()).toContain(t("filter.compatSourceDefault"));

    await button.trigger("click");
    expect(lib.compatSource).toBeNull();
    expect(button.text()).toContain(t("filter.compatSourceAll"));
  });

  it("bietet zuletzt gespielt als sortierschlüssel an", async () => {
    const lib = useLibraryStore();
    const wrapper = mount(FilterBar);
    const sort = wrapper
      .findAll("button.seg")
      .find((button) => button.text().includes(t("filter.sortLastPlayed")));

    expect(sort).toBeDefined();
    await sort?.trigger("click");

    expect(lib.sortKey).toBe("lastPlayed");
    expect(lib.sortDir).toBe("desc");
  });
});

describe("FilterBar sortierung", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLocale("en");
    useScanStore().result = result();
  });

  afterEach(() => setLocale("en"));

  it("benennt die radiogroup über das sichtbare label statt über ein zweites aria-label", async () => {
    const wrapper = mount(FilterBar);
    const group = wrapper.get("[role='radiogroup']");

    // kein doppelter text: der gruppenname hängt am sichtbaren label ...
    expect(group.attributes("aria-label")).toBeUndefined();
    const labelId = group.attributes("aria-labelledby");
    if (!labelId) throw new Error("radiogroup ohne aria-labelledby");
    const label = group.get(`[id="${labelId}"]`);
    expect(label.text()).toBe(t("filter.sort"));
    expect(wrapper.findAll(`[id="${labelId}"]`)).toHaveLength(1);

    // ... und die id bleibt über re-renders stabil (useId je instanz, nicht je render).
    await wrapper.get("input#library-search").setValue("test");
    expect(wrapper.get("[role='radiogroup']").attributes("aria-labelledby")).toBe(labelId);
  });

  it("gibt die sortierung als radiogroup mit genau einer tabbaren option aus", () => {
    const wrapper = mount(FilterBar);
    const radios = wrapper.get("[role='radiogroup']").findAll("[role='radio']");

    expect(radios).toHaveLength(4);
    expect(radios.map((radio) => radio.attributes("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(radios.map((radio) => radio.attributes("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);

    // die übrigen filter bleiben unabhängige schalter
    expect(wrapper.get("button.proton-check").attributes("aria-pressed")).toBe("false");
    expect(wrapper.get("button.compat-source").attributes("aria-pressed")).toBe("false");
  });

  it("kennzeichnet nur die filter-chips als schalter, nicht die sortier-optionen", async () => {
    const wrapper = mount(FilterBar);

    // eine auswahl ist kein schalter: aria-checked trägt den zustand, aria-pressed
    // wäre hier ein zweiter, widersprüchlicher zustand.
    expect(
      wrapper
        .get("[role='radiogroup']")
        .findAll("[role='radio']")
        .map((radio) => radio.attributes("aria-pressed")),
    ).toEqual([undefined, undefined, undefined, undefined]);

    const tierPill = wrapper.get("button.tier-pill");
    const tool = wrapper.get("button[title='proton_9']");
    const library = wrapper.get("button[title='/steam/library']");
    for (const chip of [tierPill, tool, library]) {
      expect(chip.attributes("aria-pressed")).toBe("false");
    }

    await tierPill.trigger("click");
    await tool.trigger("click");
    await library.trigger("click");

    for (const chip of [tierPill, tool, library]) {
      expect(chip.attributes("aria-pressed")).toBe("true");
    }
  });

  it("wechselt auswahl und fokus mit den pfeiltasten", async () => {
    const lib = useLibraryStore();
    const wrapper = mount(FilterBar, { attachTo: document.body });
    const radios = wrapper.get("[role='radiogroup']").findAll("[role='radio']");
    const name = sortRadio(radios, t("filter.sortName"));

    expect(name.attributes("tabindex")).toBe("0");

    keydown(name.element, "ArrowRight");
    await nextTick();
    await nextTick();

    expect(lib.sortKey).toBe("size");
    expect(sortRadio(radios, t("filter.sortSize")).attributes("aria-checked")).toBe("true");
    expect(sortRadio(radios, t("filter.sortSize")).attributes("tabindex")).toBe("0");
    expect(name.attributes("aria-checked")).toBe("false");
    expect(name.attributes("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(sortRadio(radios, t("filter.sortSize")).element);

    keydown(sortRadio(radios, t("filter.sortSize")).element, "ArrowLeft");
    await nextTick();
    await nextTick();

    expect(lib.sortKey).toBe("name");
    expect(document.activeElement).toBe(name.element);

    // zyklisch rückwärts vom ersten auf den letzten eintrag
    keydown(name.element, "ArrowUp");
    await nextTick();
    await nextTick();

    expect(lib.sortKey).toBe("lastPlayed");
    expect(document.activeElement).toBe(sortRadio(radios, t("filter.sortLastPlayed")).element);

    // und vorwärts vom letzten zurück auf den ersten. Home/End sind nicht
    // implementiert und werden deshalb nicht geprüft.
    keydown(sortRadio(radios, t("filter.sortLastPlayed")).element, "ArrowDown");
    await nextTick();
    await nextTick();

    expect(lib.sortKey).toBe("name");
    expect(document.activeElement).toBe(name.element);

    wrapper.unmount();
  });

  it("lässt die richtung stehen, wenn der pfeilschritt auf dem aktiven key landet", async () => {
    const lib = useLibraryStore();
    lib.setSort("size"); // name -> size, default-richtung desc
    expect(lib.sortKey).toBe("size");
    expect(lib.sortDir).toBe("desc");

    const wrapper = mount(FilterBar, { attachTo: document.body });
    const radios = wrapper.get("[role='radiogroup']").findAll("[role='radio']");

    // aktives radio: der pfeil wechselt auf den nächsten key
    keydown(sortRadio(radios, t("filter.sortSize")).element, "ArrowRight");
    await nextTick();
    await nextTick();
    expect(lib.sortKey).toBe("tier");
    expect(lib.sortDir).toBe("desc");

    // zurück auf den vorher aktiven key: anderer key, also dessen default-richtung
    keydown(sortRadio(radios, t("filter.sortTier")).element, "ArrowLeft");
    await nextTick();
    await nextTick();
    expect(lib.sortKey).toBe("size");
    expect(lib.sortDir).toBe("desc");

    // guard: der fokus steht noch auf "name", aktiv ist "size" (möglich, wenn der
    // klick den fokus nicht verschiebt). der pfeilschritt landet damit auf dem
    // bereits aktiven key und darf kein setSort auslösen — sonst toggelte die
    // richtung beim bloßen durchblättern.
    keydown(sortRadio(radios, t("filter.sortName")).element, "ArrowRight");
    await nextTick();
    await nextTick();
    expect(lib.sortKey).toBe("size");
    expect(lib.sortDir).toBe("desc");
    expect(sortRadio(radios, t("filter.sortSize")).attributes("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(sortRadio(radios, t("filter.sortSize")).element);

    wrapper.unmount();
  });

  it("toggelt die richtung weiter beim klick auf das aktive sortier-radio", async () => {
    const lib = useLibraryStore();
    const wrapper = mount(FilterBar);
    const name = sortRadio(
      wrapper.get("[role='radiogroup']").findAll("[role='radio']"),
      t("filter.sortName"),
    );

    expect(name.attributes("aria-checked")).toBe("true");
    expect(lib.sortDir).toBe("asc");

    await name.trigger("click");
    expect(lib.sortKey).toBe("name");
    expect(lib.sortDir).toBe("desc");

    await name.trigger("click");
    expect(lib.sortKey).toBe("name");
    expect(lib.sortDir).toBe("asc");
  });

  it("lässt klick und enter/leertaste bei der bestehenden sortierwirkung", async () => {
    const lib = useLibraryStore();
    const wrapper = mount(FilterBar);
    const size = sortRadio(
      wrapper.get("[role='radiogroup']").findAll("[role='radio']"),
      t("filter.sortSize"),
    );

    // enter und leertaste löst der browser als klick aus; der handler darf
    // sie nicht abfangen, sonst sortiert der knopf per tastatur nicht mehr.
    expect(keydown(size.element, "Enter").defaultPrevented).toBe(false);
    expect(keydown(size.element, " ").defaultPrevented).toBe(false);
    expect(lib.sortKey).toBe("name");

    await size.trigger("click");
    expect(lib.sortKey).toBe("size");
    expect(lib.sortDir).toBe("desc");
  });
});
