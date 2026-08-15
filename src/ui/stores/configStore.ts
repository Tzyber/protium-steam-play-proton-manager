import { defineStore } from "pinia";
import { appCacheDir, tauriPorts } from "../../core/adapters/tauri";
import { removeCompatTool, writeCompatTool } from "../../core/compatwrite";
import { writeLaunchOptions } from "../../core/localconfig";
import { useScanStore } from "./scanStore";

// Einziger Weg von der UI zu Steam-Dateien; das Write-Gate liegt im Core.
export const useConfigStore = defineStore("config", {
  actions: {
    /** wirft (z. B. SteamRunningError), der drawer zeigt die meldung an. */
    async saveLaunchOptions(appId: number, value: string): Promise<"unchanged" | "written"> {
      const result = useScanStore().result;
      if (!result) throw new Error("kein scan, bitte zuerst die library scannen.");
      if (!result.steamUserId) {
        throw new Error("kein steam-account gefunden, schreiben nicht möglich.");
      }
      const backupDir = `${await appCacheDir()}/backups`;
      const r = await writeLaunchOptions(
        tauriPorts,
        result.steamRoot,
        result.steamUserId,
        appId,
        value,
        backupDir,
      );
      useScanStore().applyGameConfig(appId, { launchOptions: value });
      return r;
    },

    /**
     * setzt das proton/compat-tool für ein spiel.
     * internalName === null → mapping entfernen (standard/globaler default).
     */
    async saveCompatTool(
      appId: number,
      internalName: string | null,
    ): Promise<"unchanged" | "written"> {
      const result = useScanStore().result;
      if (!result) throw new Error("kein scan, bitte zuerst die library scannen.");
      const backupDir = `${await appCacheDir()}/backups`;
      let r: "unchanged" | "written";
      if (internalName === null) {
        r = await removeCompatTool(tauriPorts, result.steamRoot, appId, backupDir);
      } else {
        r = await writeCompatTool(tauriPorts, result.steamRoot, appId, internalName, backupDir);
      }
      useScanStore().applyGameConfig(appId, { compatTool: internalName ?? "default" });
      return r;
    },
  },
});
