// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotificationToast from "../../src/ui/components/NotificationToast.vue";
import { useUiStore } from "../../src/ui/stores/uiStore";

// spiegel von COPY_CONFIRM_MS: wie lange das kopier-häkchen stehen bleibt
const COPY_CONFIRM_MS = 2000;

let clipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  // der 30-s-timer des stores lebt außerhalb der komponente und muss hier weg,
  // solange die fake-timer noch aktiv sind
  useUiStore().dismissNotification();
  // erst die spies zurückgeben, dann die echten timer: mockRestore würde den
  // fake-timer eines timer-spies sonst wieder installieren.
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  document.body.innerHTML = "";
});

describe("NotificationToast kopier-timer", () => {
  it("nimmt das kopier-häkchen nach COPY_CONFIRM_MS zurück", async () => {
    const ui = useUiStore();
    ui.showNotification("x");
    const wrapper = mount(NotificationToast);

    await wrapper.get(".note-copy").trigger("click");
    // flushPromises aus @vue/test-utils plant über setImmediate, das ist unter
    // fake timern ebenfalls gefakt und würde hängen. die async-timer-api
    // arbeitet die microtasks dazwischen ab.
    await vi.advanceTimersByTimeAsync(0);
    expect(wrapper.get(".note-copy").text()).toBe("✓");

    await vi.advanceTimersByTimeAsync(COPY_CONFIRM_MS);
    expect(wrapper.get(".note-copy").text()).toBe("📋");

    wrapper.unmount();
  });

  it("räumt den kopier-timer beim unmount", async () => {
    const ui = useUiStore();
    ui.showNotification("x");
    const wrapper = mount(NotificationToast);

    // 30-s-auto-dismiss des stores hält bereits einen timer
    const timersBeforeCopy = vi.getTimerCount();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    await wrapper.get(".note-copy").trigger("click");
    await vi.advanceTimersByTimeAsync(0);

    const copyCallIndex = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === COPY_CONFIRM_MS);
    expect(copyCallIndex).toBeGreaterThanOrEqual(0);
    const copyTimer = setTimeoutSpy.mock.results[copyCallIndex]?.value;
    expect(copyTimer).toBeDefined();

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    wrapper.unmount();

    // genau der kopier-timer wird geräumt, nicht irgendein timer
    expect(clearTimeoutSpy).toHaveBeenCalledWith(copyTimer);
    // der store-timer bleibt stehen, der kopier-timer ist weg
    expect(vi.getTimerCount()).toBe(timersBeforeCopy);
  });

  it("unmount während eines laufenden clipboard-writes erzeugt keinen timer", async () => {
    const ui = useUiStore();
    ui.showNotification("x");

    let resolveWrite: (() => void) | undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const wrapper = mount(NotificationToast);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await wrapper.get(".note-copy").trigger("click");
    expect(writeText).toHaveBeenCalledTimes(1);

    // vor dem unmount am DOM: der write läuft noch, der knopf steht deshalb
    // unverändert auf idle und die fehler-live-region bleibt aus.
    expect(wrapper.get(".note-copy").text()).toBe("📋");
    expect(wrapper.find(".sr-only").exists()).toBe(false);

    wrapper.unmount();
    resolveWrite?.();

    // microtasks abarbeiten, ohne timer zu schieben: ein fälschlich gesetzter
    // kopier-timer darf hier gar nicht erst entstehen
    await Promise.resolve();
    await Promise.resolve();

    const copyTimerCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === COPY_CONFIRM_MS);
    expect(copyTimerCalls).toHaveLength(0);
  });
});
