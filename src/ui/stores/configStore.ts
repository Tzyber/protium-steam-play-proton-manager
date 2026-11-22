import { defineStore } from "pinia";
import { ProtiumError, SteamRunningError } from "../../core/errors";
import { parseError } from "../../core/errtext";
import type { WriteResult } from "../../core/ports";
import type { ScanResult } from "../../core/types";
import { logError, logEvent } from "../diagnostics";
import { t } from "../i18n";
import { ports } from "../ports";
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
 * geschriebene Wert nicht mehr in den neuen Snapshot, sonst zeigte die
 * Oberfläche in einem neuen Snapshot eine Änderung, die im alten Environment
 * geschrieben wurde (N6).
 */
function isSameSnapshot(snapshot: unknown, generation: number): boolean {
  const scan = useScanStore();
  return scan.result === snapshot && scan.scanGeneration === generation;
}

async function applyOrRescan(
  snapshot: ScanResult,
  generation: number,
  appId: number,
  patch: { launchOptions?: string; compatTool?: string },
  changedLog: string,
): Promise<void> {
  const scan = useScanStore();
  const current = scan.result;
  const sameEnvironment =
    scan.status !== "scanning" &&
    current !== null &&
    current.steamRoot === snapshot.steamRoot &&
    current.steamUserId === snapshot.steamUserId;
  if (isSameSnapshot(snapshot, generation) || sameEnvironment) {
    scan.applyGameConfig(appId, patch);
    return;
  }
  logEvent("info", changedLog);
  await scan.runScan();
}

// Einziger Weg von der UI zu Steam-Dateien; das Write-Gate liegt im Backend.
export const useConfigStore = defineStore("config", {
  actions: {
    /** wirft (z. B. SteamRunningError), der drawer zeigt die meldung an. */
    async saveLaunchOptions(appId: number, value: string): Promise<WriteResult> {
      const scan = useScanStore();
      const snapshot = scan.result;
      const generation = scan.scanGeneration;
      try {
        // Absichtsfehler liegen bewusst im try: als ProtiumError tragen sie
        // ihren code (B1, formatError zeigt den gepflegten text statt
        // "unbekannt"), und mapWriteError protokolliert sie wie jeden anderen
        // schreibfehler (N-3).
        if (!snapshot) {
          throw new ProtiumError("not-found", "no-scan-result", t("errors.noScanResult"));
        }
        if (!snapshot.steamUserId) {
          throw new ProtiumError("not-found", "no-steam-account", t("errors.noSteamAccount"));
        }
        const r = await ports.system.saveLaunchOptions(
          snapshot.steamRoot,
          snapshot.steamUserId,
          appId,
          value,
        );
        await applyOrRescan(
          snapshot,
          generation,
          appId,
          { launchOptions: value },
          "Startoptionen geschrieben, Snapshot hat sich geändert",
        );
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
      try {
        // siehe saveLaunchOptions: code-tragender Absichtsfehler im try.
        if (!snapshot) {
          throw new ProtiumError("not-found", "no-scan-result", t("errors.noScanResult"));
        }
        const r = await ports.system.saveCompatTool(snapshot.steamRoot, appId, internalName);
        await applyOrRescan(
          snapshot,
          generation,
          appId,
          { compatTool: internalName ?? "default" },
          "Compat-Tool geschrieben, Snapshot hat sich geändert",
        );
        return r;
      } catch (e: unknown) {
        return mapWriteError(e);
      }
    },
  },
});
