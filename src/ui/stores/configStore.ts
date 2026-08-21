import { defineStore } from "pinia";
import { tauriPorts } from "../../core/adapters/tauri";
import { SteamRunningError } from "../../core/configwrite";
import type { WriteResult } from "../../core/ports";
import { useScanStore } from "./scanStore";

// Einziger Weg von der UI zu Steam-Dateien; das Write-Gate liegt im Backend.
export const useConfigStore = defineStore("config", {
  actions: {
    /** wirft (z. B. SteamRunningError), der drawer zeigt die meldung an. */
    async saveLaunchOptions(appId: number, value: string): Promise<WriteResult> {
      const result = useScanStore().result;
      if (!result) throw new Error("kein scan, bitte zuerst die library scannen.");
      if (!result.steamUserId) {
        throw new Error("kein steam-account gefunden, schreiben nicht möglich.");
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
        const msg = String(e);
        if (msg.includes("steam is running") || msg.includes("SteamRunningError")) {
          throw new SteamRunningError();
        }
        throw e;
      }
    },

    /**
     * setzt das proton/compat-tool für ein spiel.
     * internalName === null → mapping entfernen (standard/globaler default).
     */
    async saveCompatTool(appId: number, internalName: string | null): Promise<WriteResult> {
      const result = useScanStore().result;
      if (!result) throw new Error("kein scan, bitte zuerst die library scannen.");
      try {
        const r = await tauriPorts.system.saveCompatTool(result.steamRoot, appId, internalName);
        useScanStore().applyGameConfig(appId, { compatTool: internalName ?? "default" });
        return r;
      } catch (e: unknown) {
        const msg = String(e);
        if (msg.includes("steam is running") || msg.includes("SteamRunningError")) {
          throw new SteamRunningError();
        }
        throw e;
      }
    },
  },
});
