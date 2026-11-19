// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import AppSidebar from "../../src/ui/components/AppSidebar.vue";
import { getLocale, setLocale, t } from "../../src/ui/i18n";
import { useUiStore } from "../../src/ui/stores/uiStore";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  setLocale("en");
});

describe("AppSidebar", () => {
  it("aktualisiert die navigation nach setLocale sofort ohne ansichtswechsel", async () => {
    setLocale("en");
    const wrapper = mount(AppSidebar);
    expect(wrapper.findAll(".nav-item").map((item) => item.text())).toContain("history");

    setLocale("de");
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

  it("schaltet die sprache über den sichtbaren sidebar-umschalter sofort um", async () => {
    setLocale("en");
    const wrapper = mount(AppSidebar);

    const label = wrapper.get('label[for="app-language"]');
    expect(label.classes()).toContain("label");
    expect(label.classes()).not.toContain("sr-only");
    expect(label.text()).toBe("language");

    const trigger = wrapper.get("button#app-language");
    expect(trigger.text()).toContain("English");

    await trigger.trigger("click");
    const options = wrapper.findAll('[role="option"]');
    expect(options.map((opt) => opt.text().trim())).toEqual(["German", "English"]);

    const german = options.find((opt) => opt.text().trim() === "German");
    if (!german) throw new Error("option German fehlt");
    await german.trigger("click");
    await nextTick();

    expect(getLocale()).toBe("de");
    expect(document.documentElement.lang).toBe("de");
    expect(wrapper.get("button#app-language").text()).toContain("German");
    expect(wrapper.get('label[for="app-language"]').text()).toBe("language");
    expect(wrapper.findAll(".nav-item").map((item) => item.text())).toContain("Verlauf");

    await wrapper.get("button#app-language").trigger("click");
    const english = wrapper
      .findAll('[role="option"]')
      .find((opt) => opt.text().trim() === "English");
    if (!english) throw new Error("option English fehlt");
    await english.trigger("click");
    await nextTick();

    expect(getLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(wrapper.findAll(".nav-item").map((item) => item.text())).toContain("history");
  });
});
