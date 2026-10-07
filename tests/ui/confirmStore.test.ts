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
    if (first === null) throw new Error("reserve lieferte kein token");

    expect(store.reserved).toBe(true);
    expect(store.reserve()).toBeNull();
    expect(
      store.ask({ title: "zweite löschung", message: "folge" }, { onSuccess: vi.fn() }, first + 1),
    ).toBe(false);

    expect(store.ask({ title: "erste löschung", message: "folge" }, {}, first)).toBe(true);
    store.cancel();

    expect(store.pending).toBeNull();
    expect(store.reserved).toBe(false);
    expect(store.reserve()).not.toBeNull();
  });

  it("übernimmt ein optionales confirmLabel in den dialog", () => {
    const store = useConfirmStore();
    const token = store.reserve();
    if (token === null) throw new Error("reserve lieferte kein token");

    store.ask(
      {
        title: "verschieben?",
        message: "folge",
        confirmLabel: "in den Papierkorb verschieben",
      },
      {},
      token,
    );

    expect(store.pending?.confirmLabel).toBe("in den Papierkorb verschieben");
    store.cancel();
    expect(store.pending).toBeNull();
  });

  it("schließt nach execute-fehler und übergibt ihn an onError", async () => {
    const store = useConfirmStore();
    const token = store.reserve();
    if (token === null) throw new Error("reserve lieferte kein token");
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
      token,
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

    const token = store.reserve();
    if (token === null) throw new Error("reserve lieferte kein token");
    store.ask(first, { onSuccess }, token);
    const inFlight = store.confirm();
    expect(store.busy).toBe(true);

    store.ask(
      { title: "überschrieben", message: "neue callbacks" },
      {
        onSuccess: vi.fn(),
      },
      token,
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
