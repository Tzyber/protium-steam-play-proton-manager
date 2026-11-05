// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import AppSidebar from "../../src/ui/components/AppSidebar.vue";
import { setLocale, t } from "../../src/ui/i18n";
import { useUiStore } from "../../src/ui/stores/uiStore";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  setLocale("en");
});

describe("AppSidebar", () => {
  it("übersetzt die navigation erst beim rendern, nicht beim aufbau", async () => {
    setLocale("en");
    const ui = useUiStore();
    const wrapper = mount(AppSidebar);
    expect(wrapper.findAll(".nav-item").map((item) => item.text())).toContain("history");

    setLocale("de");
    await nextTick();
    // setLocale ist kein reaktiver zustand: allein löst es keinen render aus.
    expect(wrapper.findAll(".nav-item").map((item) => item.text())).toContain("history");

    // der nächste echte render kommt aus einer reaktiven zustandsänderung (aktive
    // ansicht) und liest die sprache dann neu — kein $forceUpdate nötig.
    ui.go("history");
    await nextTick();

    const labels = wrapper.findAll(".nav-item").map((item) => item.text());
    expect(labels).toContain("Verlauf");
    expect(labels).not.toContain("history");
  });

  it("markiert die aktive ansicht und navigiert über die einträge", async () => {
    setLocale("en");
    const ui = useUiStore();
    const wrapper = mount(AppSidebar);

    const history = wrapper
      .findAll(".nav-item")
      .find((item) => item.text() === t("app.navHistory"));
    if (!history) throw new Error("kein navigationseintrag für den verlauf");

    await history.trigger("click");
    expect(ui.activeView).toBe("history");
    expect(history.attributes("aria-current")).toBe("page");
  });
});
