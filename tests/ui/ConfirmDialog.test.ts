// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import ConfirmDialog from "../../src/ui/components/ConfirmDialog.vue";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ConfirmDialog busy", () => {
  it("deaktiviert aktionen und ignoriert click, Escape und backdrop", async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { title: "löschen?", busy: true },
    });

    const buttons = document.body.querySelectorAll<HTMLButtonElement>(".dialog button");
    expect(buttons).toHaveLength(2);
    expect(Array.from(buttons).every((button) => button.disabled)).toBe(true);

    buttons[0]?.click();
    buttons[1]?.click();
    const dialog = document.body.querySelector<HTMLElement>(".dialog");
    dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.querySelector<HTMLElement>(".backdrop")?.click();

    expect(wrapper.emitted("confirm")).toBeUndefined();
    expect(wrapper.emitted("cancel")).toBeUndefined();
  });
});
