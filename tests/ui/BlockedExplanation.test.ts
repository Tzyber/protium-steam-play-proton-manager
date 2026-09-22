// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import BlockedExplanation from "../../src/ui/components/BlockedExplanation.vue";

describe("BlockedExplanation (B2)", () => {
  it("rendert Titel, Intro, Liste und Garantiesatz", () => {
    const wrapper = mount(BlockedExplanation, {
      props: {
        title: "Bereinigung nicht verfügbar",
        intro: "Protium konnte nicht sicher prüfen:",
        items: ["Library /mnt/games (unlesbar)", "Steam-Shortcuts (unlesbar)"],
        guarantee: "Durch diese Aktion wurde nichts verändert.",
      },
    });

    expect(wrapper.find(".blocked-title").text()).toBe("Bereinigung nicht verfügbar");
    expect(wrapper.find(".blocked-intro").text()).toBe("Protium konnte nicht sicher prüfen:");
    const items = wrapper.findAll(".blocked-list li");
    expect(items).toHaveLength(2);
    expect(items[0]?.text()).toBe("Library /mnt/games (unlesbar)");
    expect(items[1]?.text()).toBe("Steam-Shortcuts (unlesbar)");
    expect(wrapper.find(".blocked-guarantee").text()).toBe(
      "Durch diese Aktion wurde nichts verändert.",
    );
  });

  it("ist eine Statusmeldung, kein Alarm (kein alert bei ruhigem Zustand)", () => {
    const wrapper = mount(BlockedExplanation, {
      props: { title: "Aktion blockiert", guarantee: "Es wurde nichts verändert." },
    });
    expect(wrapper.attributes("role")).toBe("status");
  });
});
