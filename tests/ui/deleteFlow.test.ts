import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecuteDelete, mockCancelDelete } = vi.hoisted(() => ({
  mockExecuteDelete: vi.fn(async (token: string) => ({ deletedPath: token })),
  mockCancelDelete: vi.fn(async (_token: string) => {}),
}));

vi.mock("../../src/core/adapters/tauri", () => ({
  tauriPorts: {
    system: {
      executeDelete: mockExecuteDelete,
      cancelDelete: mockCancelDelete,
    },
  },
}));

import { useConfirmStore } from "../../src/ui/stores/confirmStore";
import { runDeleteFlow } from "../../src/ui/stores/deleteFlow";
import { deferred } from "../support/factories";

describe("runDeleteFlow", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockExecuteDelete.mockReset();
    mockExecuteDelete.mockImplementation(async (token) => ({ deletedPath: token }));
    mockCancelDelete.mockReset();
    mockCancelDelete.mockResolvedValue(undefined);
  });

  it("reserviert confirm vor prepare und bricht bei belegtem confirm sofort ab", async () => {
    const confirm = useConfirmStore();
    const held = confirm.reserve();
    expect(held).not.toBeNull();
    const prepareItem = vi.fn(async (id: string) => ({ token: `tok-${id}` }));

    await runDeleteFlow({
      items: ["a"],
      prepareItem,
      buildDialog: () => ({ title: "t", message: "m" }),
    });

    expect(prepareItem).not.toHaveBeenCalled();
    if (held !== null) confirm.release(held);
  });

  it("führt batch prepare → 1× confirm → N× execute → afterExecute aus und räumt auf", async () => {
    const steps: string[] = [];
    const executed: string[] = [];
    const onReserve = vi.fn(() => steps.push("reserve"));
    const onConfirmed = vi.fn(() => steps.push("confirmed"));
    const onCleanup = vi.fn();

    await runDeleteFlow({
      items: ["a", "b"],
      onReserve,
      prepareItem: async (id) => {
        steps.push(`prepare:${id}`);
        return { token: `tok-${id}`, id };
      },
      buildDialog: (prepared) => ({
        title: `Löschen (${prepared.length})`,
        message: prepared.map((p) => p.id).join(","),
        confirmLabel: "Löschen",
      }),
      onConfirmed,
      onExecuted: (p) => {
        executed.push(p.id);
        steps.push(`executed:${p.id}`);
      },
      afterExecute: async () => {
        steps.push("afterExecute");
      },
      onCleanup,
    });

    expect(useConfirmStore().pending?.title).toBe("Löschen (2)");
    await useConfirmStore().confirm();

    expect(mockExecuteDelete).toHaveBeenCalledTimes(2);
    expect(executed).toEqual(["a", "b"]);
    expect(steps).toEqual([
      "reserve",
      "prepare:a",
      "prepare:b",
      "confirmed",
      "executed:a",
      "executed:b",
      "afterExecute",
    ]);
    expect(useConfirmStore().reserved).toBe(false);
    expect(onCleanup).toHaveBeenCalledTimes(1);
  });

  it("gibt tokens über cancelDelete frei bei stale generation, cancel oder ask=false", async () => {
    let current = true;
    await runDeleteFlow({
      items: ["a", "b"],
      isCurrent: () => current,
      prepareItem: async (id) => {
        if (id === "b") current = false;
        return { token: `tok-${id}` };
      },
      buildDialog: () => ({ title: "t", message: "m" }),
    });
    expect(mockCancelDelete).toHaveBeenCalledTimes(2);
    expect(useConfirmStore().pending).toBeNull();
    expect(useConfirmStore().reserved).toBe(false);

    mockCancelDelete.mockClear();
    current = true;
    await runDeleteFlow({
      items: ["x"],
      prepareItem: async (id) => ({ token: `tok-${id}` }),
      buildDialog: () => ({ title: "t", message: "m" }),
    });
    useConfirmStore().cancel();
    expect(mockCancelDelete).toHaveBeenCalledExactlyOnceWith("tok-x");

    const onCleanup = vi.fn();
    mockCancelDelete.mockClear();
    vi.spyOn(useConfirmStore(), "ask").mockImplementationOnce((_opts, cb) => {
      cb.onCancel?.();
      return false;
    });
    await runDeleteFlow({
      items: ["y"],
      prepareItem: async (id) => ({ token: `tok-${id}` }),
      buildDialog: () => ({ title: "t", message: "m" }),
      onCleanup,
    });
    expect(mockCancelDelete).toHaveBeenCalledExactlyOnceWith("tok-y");
    expect(onCleanup).toHaveBeenCalledTimes(1);
    expect(useConfirmStore().reserved).toBe(false);
  });

  it("unterstützt prepare-teilfehler, execute-teilfehler und afterExecute vor fehlerausgabe", async () => {
    const prepareErrors: string[] = [];
    const executeErrors: string[] = [];
    const order: string[] = [];
    const gate = deferred<void>();
    mockExecuteDelete.mockRejectedValueOnce(new Error("unreadable"));

    await runDeleteFlow({
      items: ["fail-prepare", "fail-exec", "ok"],
      prepareItem: async (id) => {
        if (id === "fail-prepare") throw new Error("not-found");
        return { token: `tok-${id}`, id };
      },
      onPrepareError: (item) => prepareErrors.push(item),
      beforeConfirm: () => order.push("beforeConfirm"),
      buildDialog: (prepared) => ({ title: String(prepared.length), message: "msg" }),
      onExecuteError: (item) => executeErrors.push(item.id),
      afterExecute: async () => {
        order.push("afterExecute");
        gate.resolve();
      },
    });

    await useConfirmStore().confirm();
    await gate.promise;

    expect(prepareErrors).toEqual(["fail-prepare"]);
    expect(executeErrors).toEqual(["fail-exec"]);
    expect(order).toEqual(["beforeConfirm", "afterExecute"]);
  });

  it("leitet fehler ohne onExecuteError (single-item) an onUnexpectedError weiter", async () => {
    const onUnexpectedError = vi.fn();
    const afterExecute = vi.fn();
    mockExecuteDelete.mockRejectedValueOnce(new Error("token-expired"));

    await runDeleteFlow({
      items: ["one"],
      prepareItem: async (id) => ({ token: `tok-${id}` }),
      buildDialog: () => ({ title: "t", message: "m" }),
      afterExecute,
      onUnexpectedError,
    });
    await useConfirmStore().confirm();

    expect(afterExecute).not.toHaveBeenCalled();
    expect(onUnexpectedError).toHaveBeenCalledTimes(1);
    expect(useConfirmStore().reserved).toBe(false);
  });
});
