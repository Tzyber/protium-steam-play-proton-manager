// Bedarfsmessung des Spiels (Installation, compatdata, shadercache) als
// eigener Baustein: die Zustandsmaschine aus Kontext, Auftrags-Klammer und
// Fehlerdegradation war der größte Block im Drawer und wird nur dort gebraucht.

import { computed, type Ref, ref } from "vue";
import { tauriPorts } from "../core/adapters/tauri";
import {
  type FootprintPart,
  type GameFootprint,
  hasExternalCompatdata,
  measureGameFootprint,
} from "../core/footprint";
import type { Game, LaunchConfigStatus, ScanResult } from "../core/types";
import { sizeText } from "./format";
import { t } from "./i18n";
import { sameContext, watchContext } from "./sameContext";
import { useLatestRequest } from "./useLatestRequest";

type FootprintUiState = "idle" | "measuring" | "ready";

/** alles, was die Messung fachlich festhält: ändert sich etwas davon, ist ein
 *  laufendes Ergebnis veraltet und wird verworfen. */
interface FootprintContext {
  appId: number;
  scanGeneration: number;
  library: string;
  installdir: string | undefined;
  launchConfigStatus: LaunchConfigStatus;
  externalCompatdata: boolean;
  compatdataNotChecked: boolean;
}

const sameFootprintContext = sameContext<FootprintContext>([
  "appId",
  "scanGeneration",
  "library",
  "installdir",
  "launchConfigStatus",
  "externalCompatdata",
  "compatdataNotChecked",
]);

/** ein fehlgeschlagener Messlauf degradiert sichtbar (INV-2) statt zu werfen;
 *  externe oder ungeprüfte compatdata wird dabei nicht als Fehler gemeldet. */
function failedFootprint(context: FootprintContext): GameFootprint {
  return {
    gameInstall: { status: "failed" },
    compatdata:
      context.externalCompatdata || context.compatdataNotChecked
        ? { status: "not-requested" }
        : { status: "failed" },
    shadercache: { status: "failed" },
    summary: { status: "not-measured" },
    externalCompatdata: context.externalCompatdata,
    compatdataNotChecked: context.compatdataNotChecked,
  };
}

export function useGameFootprint(
  game: Readonly<Ref<Game | null>>,
  scan: { result: ScanResult | null; scanGeneration: number },
) {
  const context = computed<FootprintContext | null>(() => {
    const current = game.value;
    const result = scan.result;
    if (!current || !result) return null;
    const launchConfigStatus = result.launchConfigStatus;
    return {
      appId: current.appId,
      scanGeneration: scan.scanGeneration,
      library: current.library,
      installdir: current.installdir,
      launchConfigStatus,
      externalCompatdata:
        launchConfigStatus === "available" && hasExternalCompatdata(current.launchOptions),
      compatdataNotChecked: launchConfigStatus !== "available",
    };
  });

  const result = ref<GameFootprint | null>(null);
  const state = ref<FootprintUiState>("idle");
  const request = useLatestRequest(() => game.value);

  function invalidate(): void {
    request.invalidate();
    result.value = null;
    state.value = "idle";
  }

  watchContext(context, sameFootprintContext, invalidate);

  async function measure(): Promise<void> {
    const current = game.value;
    const scanResult = scan.result;
    const currentContext = context.value;
    if (!current || !scanResult || !currentContext || state.value === "measuring") return;

    const token = request.begin();
    const stillMatches = (): boolean =>
      request.matchesValue(token, () => sameFootprintContext(context.value, currentContext));
    result.value = null;
    state.value = "measuring";
    try {
      const measured = await measureGameFootprint(
        tauriPorts.system,
        current,
        scanResult.launchConfigStatus,
      );
      if (!stillMatches()) return;
      result.value = measured;
      state.value = "ready";
    } catch {
      if (!stillMatches()) return;
      result.value = failedFootprint(currentContext);
      state.value = "ready";
    }
  }

  /** gemessene werte: die belegte 0 heißt „0 B", nicht „nicht gemessen". */
  function footprintSizeText(sizeBytes: number | undefined): string {
    return sizeText(sizeBytes, { missing: t("common.notMeasured"), measured: true });
  }

  function partText(part: FootprintPart | undefined): string {
    if (state.value === "measuring") return t("drawer.footprintLoading");
    if (!part || part.status === "not-requested") return t("common.notMeasured");
    if (part.status === "failed") return t("drawer.footprintFailed");
    if (part.status === "missing") return t("drawer.footprintMissing");
    return footprintSizeText(part.sizeBytes);
  }

  function summaryLabel(summary: GameFootprint["summary"]): string {
    if (summary.status === "partial") {
      return `${t("drawer.footprintSummaryLabel")} (${t("drawer.footprintSummaryPartial")})`;
    }
    return t("drawer.footprintSummaryLabel");
  }

  function summaryText(): string {
    if (state.value === "measuring") return t("drawer.footprintLoading");
    const summary = result.value?.summary;
    if (!summary || summary.status === "not-measured") return t("common.notMeasured");
    return footprintSizeText(summary.sizeBytes);
  }

  return {
    context,
    result,
    state,
    invalidate,
    measure,
    partText,
    summaryLabel,
    summaryText,
  };
}
