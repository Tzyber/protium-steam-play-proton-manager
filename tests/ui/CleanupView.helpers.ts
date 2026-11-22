import { vi } from "vitest";
import { tauriPorts } from "../../src/core/adapters/tauri";
import * as shortcuts from "../../src/core/shortcuts";
import { MOCK_TOKEN_TTL_MS } from "../support/mockTokenTtl";

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
  const cancelDelete = vi.spyOn(tauriPorts.system, "cancelDelete").mockResolvedValue(undefined);
  const readShortcuts = vi
    .spyOn(shortcuts, "readAllShortcutAppIds")
    .mockResolvedValue({ status: "none" });
  return () => {
    isSteamRunning.mockRestore();
    prepareDelete.mockRestore();
    executeDelete.mockRestore();
    cancelDelete.mockRestore();
    readShortcuts.mockRestore();
  };
}
