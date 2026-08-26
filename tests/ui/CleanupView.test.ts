// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../src/ui/i18n";
import { useCleanupStore } from "../../src/ui/stores/cleanupStore";
import CleanupView from "../../src/ui/views/CleanupView.vue";

describe("CleanupView incomplete deletions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
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
});
