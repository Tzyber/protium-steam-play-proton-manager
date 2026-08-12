import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../../src/ui/stores/uiStore";

describe("uiStore notification", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("showNotification setzt notification", () => {
    const ui = useUiStore();
    expect(ui.notification).toBeNull();
    ui.showNotification("kaputt");
    expect(ui.notification?.message).toBe("kaputt");
  });

  it("neue notification überschreibt alte + resettet timer", () => {
    const ui = useUiStore();
    ui.showNotification("erster fehler");
    vi.advanceTimersByTime(10_000);
    ui.showNotification("zweiter fehler");
    expect(ui.notification?.message).toBe("zweiter fehler");

    // ohne clearTimeout hätte der timer des ersten calls bei t=30s gefeuert
    // (20s nach dem zweiten call) und die zweite notification gekillt.
    vi.advanceTimersByTime(19_000); // t=29s, timer1 wäre noch nicht gefeuert
    expect(ui.notification?.message).toBe("zweiter fehler");
    vi.advanceTimersByTime(10_000); // t=39s, timer1 hätte längst gefeuert
    expect(ui.notification?.message).toBe("zweiter fehler");
    vi.advanceTimersByTime(1_000); // t=40s, timer2 feuert
    expect(ui.notification).toBeNull();
  });

  it("auto-dismiss nach 30s", () => {
    const ui = useUiStore();
    ui.showNotification("kaputt");
    vi.advanceTimersByTime(29_999);
    expect(ui.notification).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(ui.notification).toBeNull();
  });

  it("dismissNotification räumt sofort auf + hinterlässt keinen timer", () => {
    const ui = useUiStore();
    ui.showNotification("kaputt");
    ui.dismissNotification();
    expect(ui.notification).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(ui.notification).toBeNull();
  });

  it("dismiss ohne notification ist ein no-op", () => {
    const ui = useUiStore();
    expect(() => ui.dismissNotification()).not.toThrow();
  });
});
