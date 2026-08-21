// Delegiert das Setzen und Entfernen von Compat-Tool-Mappings an den System-Port.
import type { System, WriteResult } from "./ports.js";

export type CompatWriteResult = WriteResult;

/**
 * setzt das compat-tool eines spiels in config.vdf via Write-Gate.
 */
export async function writeCompatTool(
  ports: { system: System },
  steamRoot: string,
  appId: number,
  internalName: string,
): Promise<CompatWriteResult> {
  return ports.system.saveCompatTool(steamRoot, appId, internalName);
}

/** hebt das mapping auf → spiel fällt auf den globalen default zurück. */
export async function removeCompatTool(
  ports: { system: System },
  steamRoot: string,
  appId: number,
): Promise<CompatWriteResult> {
  return ports.system.saveCompatTool(steamRoot, appId, null);
}
