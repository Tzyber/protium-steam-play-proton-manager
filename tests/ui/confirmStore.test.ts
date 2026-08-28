import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConfirmStore } from "../../src/ui/stores/confirmStore";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("confirmStore", () => {
  it("reserviert den gemeinsamen dialog atomar und gibt ihn bei cancel frei", () => {
    const store = useConfirmStore();
    const first = store.reserve();

    expect(first).not.toBeNull();
    expect(store.reserved).toBe(true);
    expect(store.reserve()).toBeNull();
    expect(store.ask({ title: "zweite löschung", message: "folge" }, { onSuccess: vi.fn() })).toBe(
      false,
    );

    expect(store.ask({ title: "erste löschung", message: "folge" }, {}, first ?? -1)).toBe(true);
    store.cancel();

    expect(store.pending).toBeNull();
    expect(store.reserved).toBe(false);
    expect(store.reserve()).not.toBeNull();
  });

  it("schließt nach execute-fehler und übergibt ihn an onError", async () => {
    const store = useConfirmStore();
    const error = new Error("token expired");
    const onError = vi.fn();

    store.ask(
      { title: "löschen?", message: "folge" },
      {
        onSuccess: async () => {
          throw error;
        },
        onError,
      },
    );

    await store.confirm();

    expect(onError).toHaveBeenCalledWith(error);
    expect(store.pending).toBeNull();
    expect(store.busy).toBe(false);
    expect(store.reserved).toBe(false);
  });

  it("ignoriert ask, cancel und confirm während busy", async () => {
    const store = useConfirmStore();
    const first = { title: "erste löschung", message: "folge" };
    const onSuccess = vi.fn<() => Promise<void>>();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    onSuccess.mockImplementation(async () => blocked);

    store.ask(first, { onSuccess });
    const inFlight = store.confirm();
    expect(store.busy).toBe(true);

    store.ask(
      { title: "überschrieben", message: "neue callbacks" },
      {
        onSuccess: vi.fn(),
      },
    );
    store.cancel();
    await store.confirm();

    expect(store.pending).toEqual(first);
    expect(onSuccess).toHaveBeenCalledTimes(1);

    release?.();
    await inFlight;

    expect(store.pending).toBeNull();
    expect(store.busy).toBe(false);
  });
});
