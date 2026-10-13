import type { mount } from "@vue/test-utils";
import { vi } from "vitest";
import { nextTick } from "vue";
import { tauriPorts } from "../../src/core/adapters/tauri";
import * as shortcuts from "../../src/core/shortcuts";
import { MOCK_TOKEN_TTL_MS } from "../support/mockTokenTtl";

/** T-05: der view-flow hängt nur an Vue-Ticks und microtasks, es gibt keinen
 *  timer im pfad. Zwei Ticks plus ein microtask-drain sind deterministisch,
 *  während die früheren setTimeout(20)-Waits unter Last flakten. */
export async function settleView(): Promise<void> {
  await nextTick();
  await nextTick();
  await Promise.resolve();
}

export function stubDeletePorts(rejectPath?: string): () => void {
  const isSteamRunning = vi.spyOn(tauriPorts.system, "isSteamRunning").mockResolvedValue(false);
  const prepareDelete = vi
    .spyOn(tauriPorts.system, "prepareDelete")
    .mockImplementation(async (req) => {
      if (req.path === rejectPath) throw new Error("prepare abgelehnt");
      return {
        token: `token-${req.path}`,
        expiresAt: Date.now() + MOCK_TOKEN_TTL_MS,
        targetType: req.targetType,
        targetPath: req.path,
        consequences: [],
      };
    });
  const executeDelete = vi
    .spyOn(tauriPorts.system, "executeDelete")
    .mockResolvedValue({ deletedPath: "" });
  const readShortcuts = vi
    .spyOn(shortcuts, "readAllShortcutAppIds")
    .mockResolvedValue({ status: "none" });
  return () => {
    isSteamRunning.mockRestore();
    prepareDelete.mockRestore();
    executeDelete.mockRestore();
    readShortcuts.mockRestore();
  };
}

export function pressedRows(wrapper: ReturnType<typeof mount>, panel: string): boolean[] {
  return wrapper.findAll(`${panel} .row`).map((row) => row.attributes("aria-pressed") === "true");
}

export function buttonWithText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll("button").find((button) => button.text() === text);
}
