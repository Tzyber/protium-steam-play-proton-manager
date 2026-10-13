// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import CleanupView from "../../src/ui/views/CleanupView.vue";

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
    expect(trigger).toBeInstanceOf(HTMLElement);
    expect(
      trigger && wrapper.get("[data-testid='steam-owned-total']").element.contains(trigger),
    ).toBe(true);

    const wrapperEl = trigger as HTMLElement;
    wrapperEl.click();
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector("[role='dialog']")?.textContent).toContain(
      t("explain.topics.steamOwned.meaning"),
    );
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
    expect(triggers.get(topic)?.tagName).toBe("BUTTON");
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
        store.orphanError = t("errors.scanIncomplete", { paths: "/lib" });
      });

      const topic = t("explain.open", { topic: t("explain.topics.cleanupBlocked.title") });
      expect(wrapper.get("#cv-panel-shaders").text()).toContain(t("cleanup.unavailable"));
      expect(topicTriggers(wrapper).get(topic)).toBeDefined();

      await wrapper.get("#cv-tab-prefixes").trigger("click");
      expect(topicTriggers(wrapper).get(topic)).toBeDefined();
      await wrapper.get("#cv-tab-trash").trigger("click");
      await wrapper.vm.$nextTick();
      expect(wrapper.get("#cv-panel-trash").text()).toContain(t("cleanup.trashEmptyState"));
      expect(wrapper.get("#cv-panel-trash").text()).not.toContain(t("cleanup.unavailable"));
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

  it("öffnet die Erklärung zum blockierten Bereich über den nativen Button", async () => {
    const wrapper = mountView((store) => {
      store.blockedBySkipped = true;
      store.orphanError = t("errors.scanIncomplete", { paths: "/lib" });
    });
    const topic = t("explain.open", { topic: t("explain.topics.cleanupBlocked.title") });
    const trigger = topicTriggers(wrapper).get(topic);
    expect(trigger).toBeDefined();
    const button = trigger as HTMLButtonElement;

    // Enter und Leertaste kommen aus der nativen Button-Semantik; ein eigener
    // Keydown-Handler waere Doppelung.
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");

    button.click();
    await wrapper.vm.$nextTick();
    const dialog = document.body.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain(t("explain.topics.cleanupBlocked.meaning"));
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
  });
});
