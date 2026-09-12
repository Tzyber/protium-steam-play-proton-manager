// Bedarfsmessung des Spiels (Installation, compatdata, shadercache) als
// eigener Baustein: die Zustandsmaschine aus Kontext, Auftrags-Klammer und
// Fehlerdegradation war der größte Block im Drawer und wird nur dort gebraucht.

import { computed, type Ref, ref, watch } from "vue";
import { tauriPorts } from "../core/adapters/tauri";
import {
  type FootprintPart,
  type GameFootprint,
  hasExternalCompatdata,
  measureGameFootprint,
} from "../core/footprint";
import type { Game, LaunchConfigStatus, ScanResult } from "../core/types";
import { formatKnownBytes } from "./format";
import { t } from "./i18n";
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

function sameFootprintContext(
  left: FootprintContext | null,
  right: FootprintContext | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.appId === right.appId &&
    left.scanGeneration === right.scanGeneration &&
    left.library === right.library &&
    left.installdir === right.installdir &&
    left.launchConfigStatus === right.launchConfigStatus &&
    left.externalCompatdata === right.externalCompatdata &&
    left.compatdataNotChecked === right.compatdataNotChecked
  );
}

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

  watch(
    context,
    (current, previous) => {
      if (previous === undefined || !sameFootprintContext(current, previous)) {
        invalidate();
      }
    },
    { immediate: true },
  );

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

  function sizeText(sizeBytes: number | undefined): string {
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      return t("common.notMeasured");
    }
    return formatKnownBytes(sizeBytes);
  }

  function partText(part: FootprintPart | undefined): string {
    if (state.value === "measuring") return t("drawer.footprintLoading");
    if (!part || part.status === "not-requested") return t("common.notMeasured");
    if (part.status === "failed") return t("drawer.footprintFailed");
    if (part.status === "missing") return t("drawer.footprintMissing");
    return sizeText(part.sizeBytes);
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
    return sizeText(summary.sizeBytes);
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
