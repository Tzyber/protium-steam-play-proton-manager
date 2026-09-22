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

/**
 * Ein Write läuft gegen den beim Aufruf gelesenen Scan (root/account). Ein
 * zwischenzeitlicher Rescan ersetzt `scan.result`; dann gehört der
 * geschriebene Wert nicht mehr in den neuen Snapshot — sonst zeigte die
 * Oberfläche in einem neuen Snapshot eine Änderung, die im alten Environment
 * geschrieben wurde (N6).
 */
function isSameSnapshot(snapshot: unknown, generation: number): boolean {
  const scan = useScanStore();
  return scan.result === snapshot && scan.scanGeneration === generation;
}

// Einziger Weg von der UI zu Steam-Dateien; das Write-Gate liegt im Backend.
export const useConfigStore = defineStore("config", {
  actions: {
    /** wirft (z. B. SteamRunningError), der drawer zeigt die meldung an. */
    async saveLaunchOptions(appId: number, value: string): Promise<WriteResult> {
      const scan = useScanStore();
      const snapshot = scan.result;
      const generation = scan.scanGeneration;
      if (!snapshot) throw new Error(t("errors.noScanResult"));
      if (!snapshot.steamUserId) {
        throw new Error(t("errors.noSteamAccount"));
      }
      try {
        const r = await tauriPorts.system.saveLaunchOptions(
          snapshot.steamRoot,
          snapshot.steamUserId,
          appId,
          value,
        );
        if (isSameSnapshot(snapshot, generation)) {
          scan.applyGameConfig(appId, { launchOptions: value });
        } else {
          logEvent("info", "Startoptionen geschrieben, Snapshot hat sich geändert");
        }
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
      const scan = useScanStore();
      const snapshot = scan.result;
      const generation = scan.scanGeneration;
      if (!snapshot) throw new Error(t("errors.noScanResult"));
      try {
        const r = await tauriPorts.system.saveCompatTool(snapshot.steamRoot, appId, internalName);
        if (isSameSnapshot(snapshot, generation)) {
          scan.applyGameConfig(appId, { compatTool: internalName ?? "default" });
        } else {
          logEvent("info", "Compat-Tool geschrieben, Snapshot hat sich geändert");
        }
        return r;
      } catch (e: unknown) {
        return mapWriteError(e);
      }
    },
  },
});
