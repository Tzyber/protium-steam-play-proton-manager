// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import SelectBox from "../../src/ui/components/SelectBox.vue";

const options = [
  { value: "one", label: "One" },
  { value: "two", label: "Two" },
];

afterEach(() => {
  document.body.innerHTML = "";
});

function tabEvent(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Tab",
    shiftKey,
  });
}

describe("SelectBox", () => {
  it("rendert stabile, eindeutige trigger- und listbox-ids", async () => {
    const first = mount(SelectBox, { props: { modelValue: "one", options } });
    const second = mount(SelectBox, { props: { modelValue: "one", options } });
    const firstTrigger = first.find("button");
    const secondTrigger = second.find("button");

    expect(firstTrigger.attributes("id")).toBeTruthy();
    expect(secondTrigger.attributes("id")).toBeTruthy();
    expect(firstTrigger.attributes("id")).not.toBe(secondTrigger.attributes("id"));

    const firstTriggerId = firstTrigger.attributes("id");
    await firstTrigger.trigger("click");
    const firstList = first.find('[role="listbox"]');

    expect(firstTrigger.attributes("id")).toBe(firstTriggerId);
    expect(firstList.attributes("id")).toBeTruthy();
    expect(firstList.attributes("id")).not.toBe(secondTrigger.attributes("id"));
    expect(firstTrigger.attributes("aria-controls")).toBe(firstList.attributes("id"));
    expect(firstList.attributes("aria-labelledby")).toBe(firstTriggerId);

    await firstTrigger.trigger("click");
    expect(firstTrigger.attributes("aria-controls")).toBeUndefined();
  });

  it("behält eine übergebene trigger-id", () => {
    const wrapper = mount(SelectBox, {
      props: { id: "compat-tool", modelValue: "one", options },
    });

    expect(wrapper.find("button").attributes("id")).toBe("compat-tool");
  });

  it("schließt bei Tab auf dem trigger, ohne den default zu verhindern", async () => {
    const wrapper = mount(SelectBox, { props: { modelValue: "one", options } });
    const trigger = wrapper.find("button");
    await trigger.trigger("click");

    const event = tabEvent();
    trigger.element.dispatchEvent(event);
    await wrapper.vm.$nextTick();

    expect(event.defaultPrevented).toBe(false);
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
  });

  it("schließt bei Tab und Shift+Tab auf einer option, ohne den default zu verhindern", async () => {
    for (const shiftKey of [false, true]) {
      const wrapper = mount(SelectBox, { props: { modelValue: "one", options } });
      await wrapper.find("button").trigger("click");
      const option = wrapper.find('[role="option"]');
      const event = tabEvent(shiftKey);

      option.element.dispatchEvent(event);
      await wrapper.vm.$nextTick();

      expect(event.defaultPrevented).toBe(false);
      expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
      wrapper.unmount();
    }
  });
});
