import { defineStore } from "pinia";
import { tauriPorts } from "../../core/adapters/tauri";
import { recomputeToolUsedBy } from "../../core/compat";
import { deriveProtonCheck } from "../../core/protoncheck";
import { scanLocal } from "../../core/scan/local";
import { enrichProtondb } from "../../core/scan/protondb";
import type { ScanResult } from "../../core/types";
import { errMsg } from "../format";
import { t } from "../i18n";
import { useUiStore } from "./uiStore";

type Status = "idle" | "scanning" | "done" | "not-found" | "error";
const PROTONDB_DELAY_MS = 150;

interface State {
  status: Status;
  statusText: string;
  error: string | null;
  result: ScanResult | null;
  elapsedMs: number;
  protonDbRemaining: number;
  scanGeneration: number;
}

export const useScanStore = defineStore("scan", {
  state: (): State => ({
    status: "idle",
    statusText: t("status.ready"),
    error: null,
    result: null,
    elapsedMs: 0,
    protonDbRemaining: 0,
    scanGeneration: 0,
  }),
  getters: {
    games: (s) => s.result?.games ?? [],
    warnings: (s) => s.result?.warnings ?? [],
    compatTools: (s) => s.result?.compatToolsInstalled ?? [],
    protonChecks: (s) => (s.result ? deriveProtonCheck(s.result) : []),
    protonCheckAppIds(): Set<number> {
      return new Set(this.protonChecks.map((check) => check.appId));
    },
  },
  actions: {
    async runScan() {
      const generation = this.scanGeneration + 1;
      this.scanGeneration = generation;
      this.status = "scanning";
      this.statusText = t("status.findingSteam");
      this.error = null;
      this.elapsedMs = 0;
      this.protonDbRemaining = 0;
      const t0 = performance.now();
      const isCurrent = (result?: ScanResult): boolean =>
        this.scanGeneration === generation && (result === undefined || this.result === result);
      try {
        const environment = await tauriPorts.system.discoverSteamEnvironment();
        if (!isCurrent()) return;
        this.statusText = t("status.scanningLibrary");
        const local = await scanLocal(tauriPorts, environment);
        if (!isCurrent()) return;
        this.result = { steamRoot: environment.steamRoot, ...local };
        const result = this.result;
        if (result === null) return;
        this.status = "done";
        this.statusText = t("status.ready");
        this.protonDbRemaining = result.games.length;
        if (result.games.length === 0) return;

        void enrichProtondb(tauriPorts, result.games, PROTONDB_DELAY_MS, {
          shouldApply: () => isCurrent(result),
          onSettled: () => {
            if (!isCurrent(result)) return;
            this.protonDbRemaining = Math.max(0, this.protonDbRemaining - 1);
          },
        })
          .catch(() => {
            if (isCurrent(result)) this.protonDbRemaining = 0;
          })
          .then(() => {
            if (isCurrent(result)) this.protonDbRemaining = 0;
          });
      } catch (e) {
        if (!isCurrent()) return;
        if (errMsg(e).includes("steam installation not found")) {
          this.status = "not-found";
          this.statusText = t("status.noSteamInstallation");
        } else {
          const msg = errMsg(e);
          this.status = "error";
          this.statusText = t("status.error");
          this.error = msg;
          useUiStore().showNotification(t("status.scanFailed", { error: msg }));
        }
      } finally {
        if (isCurrent()) this.elapsedMs = Math.round(performance.now() - t0);
      }
    },

    /** einzige stelle, die spiel-konfigurationsfelder im scan-result setzt.
     *  kein throw: der write in die steam-datei war erfolgreich, das update
     *  im speicher ist nur ein cache. */
    applyGameConfig(appId: number, patch: { launchOptions?: string; compatTool?: string }) {
      const result = this.result;
      if (!result) return;
      const game = result.games.find((g) => g.appId === appId);
      if (!game) return;
      if (patch.launchOptions !== undefined) game.launchOptions = patch.launchOptions;
      if (patch.compatTool !== undefined) {
        game.compatTool = patch.compatTool;
        game.compatToolSource =
          patch.compatTool === "default"
            ? result.defaultCompatTool === null
              ? "unavailable"
              : "default"
            : "explicit";
        // usedBy der tools folgt dem mapping, nach dem wechsel neu aus den
        // spielen rechnen, sonst zeigt der proton-manager stale zähler.
        recomputeToolUsedBy(result.compatToolsInstalled, result.games);
      }
    },
  },
});
