// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import { trapFocus } from "../../src/ui/a11y.js";
import ExplainInfo from "../../src/ui/components/ExplainInfo.vue";
import { setLocale, t } from "../../src/ui/i18n/index.js";

const parentEvents = { keydown: 0 };

const ParentTrap = defineComponent({
  components: { ExplainInfo },
  setup() {
    const parentRef = ref<HTMLElement | null>(null);
    function onKeydown(event: KeyboardEvent): void {
      parentEvents.keydown += 1;
      trapFocus(event, parentRef.value);
    }
    return { parentRef, onKeydown };
  },
  template: `
    <div ref="parentRef" data-testid="parent-trap" @keydown="onKeydown">
      <button data-testid="outside-before" type="button">before</button>
      <ExplainInfo topic="compat-tool" />
      <button data-testid="outside-after" type="button">after</button>
    </div>
  `,
});

afterEach(() => {
  document.body.innerHTML = "";
  parentEvents.keydown = 0;
  setLocale("en");
});

describe("ExplainInfo", () => {
  it("rendert einen kontextuellen trigger mit eindeutigen ARIA-Referenzen", () => {
    const wrapper = mount(ParentTrap, { attachTo: document.body });
    const trigger = wrapper.get("[data-testid='explain-trigger']");
    const controls = trigger.attributes("aria-controls");

    expect(trigger.attributes("type")).toBe("button");
    expect(trigger.attributes("aria-label")).toBe(
      t("explain.open", { topic: t("explain.topics.compatTool.title") }),
    );
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(controls).toMatch(/^explain-dialog-/);
    expect(wrapper.find(`#${controls}`).exists()).toBe(false);
  });

  it.each(["de", "en"] as const)(
    "öffnet die lokale Erklärung mit Quelle, Bedeutung und Grenze in %s",
    async (locale) => {
      setLocale(locale);
      const wrapper = mount(ParentTrap, { attachTo: document.body });
      const trigger = wrapper.get("[data-testid='explain-trigger']");
      await trigger.trigger("click");
      await nextTick();

      const dialog = wrapper.get("[role='dialog']");
      const titleId = dialog.attributes("aria-labelledby");
      const descriptionId = dialog.attributes("aria-describedby");
      expect(wrapper.element.contains(dialog.element)).toBe(true);
      expect(dialog.attributes("aria-modal")).toBe("true");
      expect(wrapper.find(`#${titleId}`).exists()).toBe(true);
      expect(wrapper.find(`#${descriptionId}`).exists()).toBe(true);
      expect(dialog.text()).toContain(t("explain.sourceLabel"));
      expect(dialog.text()).toContain(t("explain.meaningLabel"));
      expect(dialog.text()).toContain(t("explain.limitLabel"));
      expect(dialog.text()).toContain(t("explain.topics.compatTool.source"));
      expect(dialog.text()).toContain(t("explain.topics.compatTool.meaning"));
      expect(dialog.text()).toContain(t("explain.topics.compatTool.limit"));
      expect(trigger.attributes("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(dialog.get("[data-testid='explain-close']").element);
    },
  );

  it.each(["Enter", " "])("öffnet auch per %s und isoliert inneres Tab/Escape", async (key) => {
    const wrapper = mount(ParentTrap, { attachTo: document.body });
    const trigger = wrapper.get("[data-testid='explain-trigger']");
    await trigger.trigger("keydown", { key });
    await nextTick();
    parentEvents.keydown = 0;

    const dialog = wrapper.get("[role='dialog']");
    const close = dialog.get("[data-testid='explain-close']");
    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    close.element.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(true);
    expect(parentEvents.keydown).toBe(0);
    expect(document.activeElement).toBe(close.element);

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    close.element.dispatchEvent(escapeEvent);
    await nextTick();
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(parentEvents.keydown).toBe(0);
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);

    trigger.element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(parentEvents.keydown).toBe(1);
  });

  it("schließt bei Kontextwechsel ohne inneren Fokus-Restore und unmountet ohne Fokusklau", async () => {
    const wrapper = mount(ExplainInfo, {
      attachTo: document.body,
      props: { topic: "compat-tool", contextKey: 620 },
    });
    await wrapper.get("[data-testid='explain-trigger']").trigger("click");
    await nextTick();
    expect(wrapper.find("[role='dialog']").exists()).toBe(true);

    await wrapper.setProps({ contextKey: 621 });
    await nextTick();
    expect(wrapper.find("[role='dialog']").exists()).toBe(false);
    expect(document.activeElement).not.toBe(wrapper.get("[data-testid='explain-trigger']").element);

    const parentFocus = document.createElement("button");
    document.body.appendChild(parentFocus);
    parentFocus.focus();
    wrapper.unmount();
    expect(document.activeElement).toBe(parentFocus);
  });
});
