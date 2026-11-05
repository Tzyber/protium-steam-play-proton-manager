import { defineStore } from "pinia";
import { tauriPorts } from "../../core/adapters/tauri";
import { recomputeToolUsedBy } from "../../core/compatTools";
import { parseError } from "../../core/errtext";
import { deriveProtonCheck } from "../../core/protoncheck";
import { deriveScanCoverage } from "../../core/scan/coverage";
import { scanLocal } from "../../core/scan/local";
import { enrichProtondb } from "../../core/scan/protondb";
import type { ScanResult } from "../../core/types";
import { logError, logEvent } from "../diagnostics";
import { formatError } from "../formatError";
import { t } from "../i18n";
import { useLibraryStore } from "./libraryStore";
import { useUiStore } from "./uiStore";

export type ScanStatus = "idle" | "scanning" | "done" | "not-found" | "error";

/** zwischenphase eines laufenden scans. der store hält sie getrennt vom status,
 *  damit die übersetzung erst in der ansicht entsteht (FR-1): ein im store
 *  abgelegter text bliebe sonst in der sprache des scan-zeitpunkts stehen. */
type ScanPhase = "idle" | "finding-steam" | "scanning-library";

// K-01: der ProtonDB-Nachlauf läuft bewusst im Store, nicht in einer
// core-Orchestrierung. Er muss das lokale Resultat sofort anzeigen und den
// Reststatus (protonDbRemaining, Generations-Guard) führen; ein gemeinsames
// scanLibrary würde den Store an einen blockierenden await binden. Deshalb lebt
// die Delay-Konstante genau einmal hier (die frühere Dopplung in scan.ts ist
// mit dieser Datei entfallen).
const PROTONDB_DELAY_MS = 150;

interface State {
  status: ScanStatus;
  scanPhase: ScanPhase;
  error: string | null;
  result: ScanResult | null;
  elapsedMs: number;
  protonDbRemaining: number;
  scanGeneration: number;
}

export const useScanStore = defineStore("scan", {
  state: (): State => ({
    status: "idle",
    scanPhase: "idle",
    error: null,
    result: null,
    elapsedMs: 0,
    protonDbRemaining: 0,
    scanGeneration: 0,
  }),
  getters: {
    games: (s) => s.result?.games ?? [],
    warnings: (s) => s.result?.warnings ?? [],
    coverage: (s) => (s.status === "done" && s.result ? deriveScanCoverage(s.result) : null),
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
      this.scanPhase = "finding-steam";
      this.error = null;
      this.elapsedMs = 0;
      this.protonDbRemaining = 0;
      const t0 = performance.now();
      const isCurrent = (result?: ScanResult): boolean =>
        this.scanGeneration === generation && (result === undefined || this.result === result);
      try {
        const environment = await tauriPorts.system.discoverSteamEnvironment();
        if (!isCurrent()) return;
        this.scanPhase = "scanning-library";
        const local = await scanLocal(tauriPorts, environment);
        if (!isCurrent()) return;
        this.result = { steamRoot: environment.steamRoot, ...local };
        const result = this.result;
        // gate ist "nicht unvollständig", nicht "vollständig": auch limited
        // (launch-config ambiguous/missing, compat-config missing) beschneidet,
        // weil das inventar aus result.games kommt, derselben quelle wie die
        // chips. incomplete (fehlende library, manifest-/config-fehler) darf
        // filter nicht löschen.
        if (deriveScanCoverage(result).state !== "incomplete") {
          useLibraryStore().pruneFilters({
            libraries: result.games.map((g) => g.library),
            compatTools: result.games.map((g) => g.compatTool),
          });
        }
        this.status = "done";
        this.scanPhase = "idle";
        logEvent(
          "info",
          `Scan abgeschlossen: ${result.games.length} Spiele, ${result.warnings.length} Warnungen`,
        );
        // Die Oberfläche zeigt vom Warnungs-Detail nur, was als bekannter
        // Fehlercode übersetzbar ist. Der Rohtext bleibt hier im lokalen
        // Protokoll erhalten, sonst wäre die Ursache (z. B. EACCES auf einer
        // Config) nirgends nachvollziehbar (V1).
        for (const warning of result.warnings) {
          if (warning.detail) {
            logEvent("warn", `Scan-Warnung ${warning.type}: ${warning.detail}`);
          }
        }
        this.protonDbRemaining = result.games.length;
        if (result.games.length === 0) return;

        void enrichProtondb(tauriPorts, result.games, PROTONDB_DELAY_MS, {
          shouldApply: () => isCurrent(result),
          onSettled: () => {
            if (!isCurrent(result)) return;
            this.protonDbRemaining = Math.max(0, this.protonDbRemaining - 1);
          },
        })
          // beide pfade: bei fehlern (.catch) und nach abschluss (.then)
          // zählt der zähler auf 0; ohne .catch bliebe er bei einem
          // background-reject hängen.
          .catch(() => {
            if (isCurrent(result)) this.protonDbRemaining = 0;
          })
          .then(() => {
            if (isCurrent(result)) this.protonDbRemaining = 0;
          });
      } catch (e) {
        if (!isCurrent()) return;
        // ein altes ergebnis nach gescheitertem rescan zeigte root und tools,
        // die es so nicht mehr gibt; löschaktionen liefen gegen den alten root.
        this.result = null;
        if (parseError(e).code === "steam-not-found") {
          logEvent("info", "Scan: keine Steam-Installation gefunden");
          this.status = "not-found";
          this.scanPhase = "idle";
        } else {
          const msg = formatError(e);
          this.status = "error";
          this.scanPhase = "idle";
          this.error = msg;
          useUiStore().showNotification(t("status.scanFailed", { error: msg }));
          logError("Scan fehlgeschlagen", e);
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
