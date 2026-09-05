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
    return { parentRef, onKeydown, label: t("explain.topics.compatTool.title") };
  },
  template: `
    <div ref="parentRef" data-testid="parent-trap" @keydown="onKeydown">
      <button data-testid="outside-before" type="button">before</button>
      <ExplainInfo :label="label" :topics="['compat-tool']" />
      <button data-testid="outside-after" type="button">after</button>
    </div>
  `,
});

function dialog(): HTMLElement | null {
  return document.body.querySelector("[role='dialog']");
}

function openDialog(): HTMLElement {
  const found = dialog();
  if (!found) throw new Error("kein offener Explain-Dialog");
  return found;
}

function query(selector: string): HTMLElement {
  const element = openDialog().querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`nicht gefunden: ${selector}`);
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
  parentEvents.keydown = 0;
  setLocale("en");
});

describe("ExplainInfo", () => {
  it("rendert einen kontextuellen trigger mit eindeutigen ARIA-Referenzen", () => {
    const wrapper = mount(ParentTrap, { attachTo: document.body });
    const trigger = wrapper.get("[data-testid='explain-trigger']");

    expect(trigger.attributes("type")).toBe("button");
    expect(trigger.attributes("aria-label")).toBe(
      t("explain.open", { topic: t("explain.topics.compatTool.title") }),
    );
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(trigger.attributes("aria-controls")).toMatch(/^explain-dialog-/);
    expect(dialog()).toBeNull();
  });

  it.each(["de", "en"] as const)(
    "öffnet die lokale Erklärung mit Quelle, Bedeutung und Grenze in %s",
    async (locale) => {
      setLocale(locale);
      const wrapper = mount(ParentTrap, { attachTo: document.body });
      const trigger = wrapper.get("[data-testid='explain-trigger']");
      await trigger.trigger("click");
      await nextTick();

      const panel = openDialog();
      expect(panel.id).toBe(trigger.attributes("aria-controls"));
      expect(panel.getAttribute("aria-modal")).toBe("true");
      expect(document.getElementById(panel.getAttribute("aria-labelledby") ?? "")).not.toBeNull();
      expect(document.getElementById(panel.getAttribute("aria-describedby") ?? "")).not.toBeNull();
      expect(panel.textContent).toContain(t("explain.sourceLabel"));
      expect(panel.textContent).toContain(t("explain.meaningLabel"));
      expect(panel.textContent).toContain(t("explain.limitLabel"));
      expect(panel.textContent).toContain(t("explain.topics.compatTool.source"));
      expect(panel.textContent).toContain(t("explain.topics.compatTool.meaning"));
      expect(panel.textContent).toContain(t("explain.topics.compatTool.limit"));
      expect(trigger.attributes("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(query("[data-testid='explain-close']"));
    },
  );

  it("listet jedes Topic des Abschnitts mit eigener Überschrift", async () => {
    const wrapper = mount(ExplainInfo, {
      attachTo: document.body,
      props: { label: "Konfiguration", topics: ["compat-tool", "global-default"] },
    });
    await wrapper.get("[data-testid='explain-trigger']").trigger("click");
    await nextTick();

    const panel = openDialog();
    expect(panel.textContent).toContain("Konfiguration");
    expect(panel.textContent).toContain(t("explain.topics.compatTool.title"));
    expect(panel.textContent).toContain(t("explain.topics.globalDefault.title"));
    expect(panel.textContent).toContain(t("explain.topics.globalDefault.limit"));
    expect(panel.querySelectorAll("dl")).toHaveLength(2);
  });

  it("isoliert Tab und Escape gegen die umgebende UI und gibt den Fokus zurück", async () => {
    const wrapper = mount(ParentTrap, { attachTo: document.body });
    const trigger = wrapper.get("[data-testid='explain-trigger']");
    await trigger.trigger("click");
    await nextTick();
    parentEvents.keydown = 0;

    const close = query("[data-testid='explain-close']");
    const tabEvent = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    close.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(true);
    expect(parentEvents.keydown).toBe(0);
    expect(document.activeElement).toBe(close);

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    close.dispatchEvent(escapeEvent);
    await nextTick();
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(parentEvents.keydown).toBe(0);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger.element);

    trigger.element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(parentEvents.keydown).toBe(1);
  });

  it("schließt per Klick auf den Hintergrund", async () => {
    const wrapper = mount(ParentTrap, { attachTo: document.body });
    const trigger = wrapper.get("[data-testid='explain-trigger']");
    await trigger.trigger("click");
    await nextTick();

    const backdrop = document.body.querySelector(".explain-backdrop");
    backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
  });

  it("bleibt offen, wenn sich nur die Topic-Liste des Abschnitts ändert", async () => {
    const wrapper = mount(ExplainInfo, {
      attachTo: document.body,
      props: { label: "Speicherbedarf", topics: ["footprint"], contextKey: 620 },
    });
    await wrapper.get("[data-testid='explain-trigger']").trigger("click");
    await nextTick();
    const close = query("[data-testid='explain-close']");

    await wrapper.setProps({ topics: ["footprint", "external-compatdata"] });
    await nextTick();

    const panel = openDialog();
    expect(panel.textContent).toContain(t("explain.topics.externalCompatdata.title"));
    expect(document.activeElement).toBe(close);
  });

  it("schließt bei Kontextwechsel ohne inneren Fokus-Restore und unmountet ohne Fokusklau", async () => {
    const wrapper = mount(ExplainInfo, {
      attachTo: document.body,
      props: { label: "Tool", topics: ["compat-tool"], contextKey: 620 },
    });
    await wrapper.get("[data-testid='explain-trigger']").trigger("click");
    await nextTick();
    expect(dialog()).not.toBeNull();

    await wrapper.setProps({ contextKey: 621 });
    await nextTick();
    expect(dialog()).toBeNull();
    expect(document.activeElement).not.toBe(wrapper.get("[data-testid='explain-trigger']").element);

    const parentFocus = document.createElement("button");
    document.body.appendChild(parentFocus);
    parentFocus.focus();
    wrapper.unmount();
    expect(document.activeElement).toBe(parentFocus);
  });
});
