import { defineStore } from "pinia";
import { tauriPorts } from "../../core/adapters/tauri";
import { SteamRunningError } from "../../core/errors";
import { parseError } from "../../core/errtext";
import type { WriteResult } from "../../core/ports";
import { logError, logEvent } from "../diagnostics";
import { t } from "../i18n";
import { useScanStore } from "./scanStore";

/** Backend-Fehler auf Typen mappen. Der Fehlercode ist der Vertrag; aus dem
 *  Meldungstext wird nichts geraten. */
function mapWriteError(e: unknown): never {
  if (parseError(e).code === "steam-running") {
    logEvent("warn", "Steam-Write abgelehnt: steam-running");
    throw new SteamRunningError();
  }
  logError("Steam-Write fehlgeschlagen", e);
  throw e instanceof Error ? e : new Error(String(e));
}

// Einziger Weg von der UI zu Steam-Dateien; das Write-Gate liegt im Backend.
export const useConfigStore = defineStore("config", {
  actions: {
    /** wirft (z. B. SteamRunningError), der drawer zeigt die meldung an. */
    async saveLaunchOptions(appId: number, value: string): Promise<WriteResult> {
      const result = useScanStore().result;
      if (!result) throw new Error(t("errors.noScanResult"));
      if (!result.steamUserId) {
        throw new Error(t("errors.noSteamAccount"));
      }
      try {
        const r = await tauriPorts.system.saveLaunchOptions(
          result.steamRoot,
          result.steamUserId,
          appId,
          value,
        );
        useScanStore().applyGameConfig(appId, { launchOptions: value });
        return r;
      } catch (e: unknown) {
        return mapWriteError(e);
      }
    },

    /**
     * setzt das proton/compat-tool für ein spiel.
     * internalName === null → mapping entfernen (standard/globaler default).
     */
    async saveCompatTool(appId: number, internalName: string | null): Promise<WriteResult> {
      const result = useScanStore().result;
      if (!result) throw new Error(t("errors.noScanResult"));
      try {
        const r = await tauriPorts.system.saveCompatTool(result.steamRoot, appId, internalName);
        useScanStore().applyGameConfig(appId, { compatTool: internalName ?? "default" });
        return r;
      } catch (e: unknown) {
        return mapWriteError(e);
      }
    },
  },
});
