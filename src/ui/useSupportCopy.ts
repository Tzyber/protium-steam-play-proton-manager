// Support-Bericht des Drawers: sammelt die Fakten des sichtbaren Spiels und
// legt sie als Text in die Zwischenablage. Der Auftrag darf nur sein eigenes
// Ergebnis eintragen (Spiel- oder Scan-Wechsel macht eine laufende Kopie
// ungültig), damit nach einem Rescan kein fremder Status stehen bleibt.

import { computed, type Ref, ref } from "vue";
import { version as appVersion } from "../../package.json";
import type { GameFootprint } from "../core/footprint";
import { projectSupportFacts } from "../core/support";
import type { Game, ScanResult } from "../core/types";
import { sameContext, watchContext } from "./sameContext";
import { formatSupportFacts } from "./supportText";
import { useLatestRequest } from "./useLatestRequest";

type SupportCopyState = "idle" | "copying" | "copied" | "failed";

interface SupportCopyContext {
  appId: number;
  scanGeneration: number;
}

const sameSupportCopyContext = sameContext<SupportCopyContext>(["appId", "scanGeneration"]);

/** Quelle der cleanup-fakten für den Bericht: die flaggen und die beiden
 *  listen, aus denen die zähler entstehen. Bewusst die Store-Form, damit der
 *  Aufrufer einfach den Store hereinreicht; die zahlen leitet `fakten()` ab. */
interface CleanupSource {
  scanning: boolean;
  trashScanning: boolean;
  prefixUnavailable: boolean;
  shaderUnavailable: boolean;
  trashUnavailable: boolean;
  incompleteDeletions: readonly unknown[];
  incompleteDeletionsUnreadable: readonly unknown[];
}

export function useSupportCopy(
  game: Readonly<Ref<Game | null>>,
  scan: { result: ScanResult | null; scanGeneration: number; status: string },
  footprint: Readonly<Ref<GameFootprint | null>>,
  cleanup: CleanupSource,
  isSaving: Readonly<Ref<boolean>>,
) {
  const state = ref<SupportCopyState>("idle");
  const request = useLatestRequest(() => game.value);

  const context = computed<SupportCopyContext | null>(() => {
    const current = game.value;
    const result = scan.result;
    if (!current || !result || scan.status !== "done") return null;
    return { appId: current.appId, scanGeneration: scan.scanGeneration };
  });

  function invalidate(): void {
    request.invalidate();
    state.value = "idle";
  }

  watchContext(context, sameSupportCopyContext, invalidate);

  const canCopy = computed(
    () => context.value !== null && !isSaving.value && state.value !== "copying",
  );

  async function copy(): Promise<void> {
    const current = game.value;
    const result = scan.result;
    const currentContext = context.value;
    if (!current || !result || !currentContext || !canCopy.value) return;

    const snapshot = formatSupportFacts(
      projectSupportFacts({
        game: current,
        result,
        footprint: footprint.value,
        cleanup: {
          scanning: cleanup.scanning,
          trashScanning: cleanup.trashScanning,
          prefixUnavailable: cleanup.prefixUnavailable,
          shaderUnavailable: cleanup.shaderUnavailable,
          trashUnavailable: cleanup.trashUnavailable,
          incompleteDeletionsCount: cleanup.incompleteDeletions.length,
          incompleteDeletionsUnreadable: cleanup.incompleteDeletionsUnreadable.length > 0,
        },
      }),
      appVersion,
    );
    const token = request.begin();
    const stillMatches = (): boolean =>
      request.matchesValue(token, () => sameSupportCopyContext(context.value, currentContext));
    state.value = "copying";

    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      if (stillMatches()) state.value = "failed";
      return;
    }

    try {
      await clipboard.writeText(snapshot);
      if (stillMatches()) state.value = "copied";
    } catch {
      if (stillMatches()) state.value = "failed";
    }
  }

  return { state, canCopy, invalidate, copy };
}
