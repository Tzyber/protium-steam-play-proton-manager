import { defineStore } from "pinia";
import { getHome, tauriPorts } from "../../core/adapters/tauri";
import { recomputeToolUsedBy } from "../../core/compat";
import { discoverSteamRoot } from "../../core/paths";
import { scanLibrary } from "../../core/scan";
import { type ScanResult, SteamNotFoundError } from "../../core/types";
import { errMsg } from "../format";
import { t } from "../i18n";
import { useUiStore } from "./uiStore";

type Status = "idle" | "scanning" | "done" | "not-found" | "error";

interface State {
  status: Status;
  statusText: string;
  error: string | null;
  result: ScanResult | null;
  elapsedMs: number;
}

export const useScanStore = defineStore("scan", {
  state: (): State => ({
    status: "idle",
    statusText: t("status.ready"),
    error: null,
    result: null,
    elapsedMs: 0,
  }),
  getters: {
    games: (s) => s.result?.games ?? [],
    warnings: (s) => s.result?.warnings ?? [],
    compatTools: (s) => s.result?.compatToolsInstalled ?? [],
  },
  actions: {
    async runScan() {
      this.status = "scanning";
      this.error = null;
      const t0 = performance.now();
      try {
        this.statusText = t("status.findingSteam");
        const home = await getHome();
        const steamRoot = await discoverSteamRoot(tauriPorts.fs, home);
        this.statusText = t("status.scanningLibrary");
        this.result = await scanLibrary(tauriPorts, { steamRoot, protonDbDelayMs: 0 });
        this.status = "done";
        this.statusText = t("status.ready");
      } catch (e) {
        if (e instanceof SteamNotFoundError) {
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
        this.elapsedMs = Math.round(performance.now() - t0);
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
        // usedBy der tools folgt dem mapping, nach dem wechsel neu aus den
        // spielen rechnen, sonst zeigt der proton-manager stale zähler.
        recomputeToolUsedBy(result.compatToolsInstalled, result.games);
      }
    },
  },
});
