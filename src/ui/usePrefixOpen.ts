import { computed, type Ref, shallowRef, watch } from "vue";
import { openPrefixFolder } from "../core/adapters/tauri";
import { hasExternalCompatdata } from "../core/footprint";
import type { Game } from "../core/types";
import type { Key } from "./i18n";
import { useScanStore } from "./stores/scanStore";

const ERROR_KEYS = {
  "external-target": "drawer.prefixExternal",
  unchecked: "drawer.prefixUnchecked",
  "not-found": "drawer.prefixNotFound",
  unreadable: "drawer.prefixUnreadable",
  blocked: "drawer.prefixBlocked",
  "handler-unavailable": "drawer.prefixHandlerUnavailable",
} as const satisfies Record<string, Key>;
const FALLBACK_KEY: Key = "drawer.prefixBlocked";

function isErrorCode(value: unknown): value is keyof typeof ERROR_KEYS {
  return typeof value === "string" && Object.hasOwn(ERROR_KEYS, value);
}

export type PrefixOpenState = "idle" | "opening" | "opened" | "failed";

interface PrefixResult {
  state: Exclude<PrefixOpenState, "idle">;
  errorKey: Key;
}

export function usePrefixOpen(game: Readonly<Ref<Game | null>>, saving: Readonly<Ref<boolean>>) {
  const scan = useScanStore();
  const context = computed(() =>
    JSON.stringify([
      game.value?.appId,
      game.value?.library,
      game.value?.launchOptions,
      scan.scanGeneration,
      scan.status,
      scan.result?.launchConfigStatus,
      saving.value,
    ]),
  );
  const result = shallowRef<PrefixResult | null>(null);
  const state = computed<PrefixOpenState>(() => result.value?.state ?? "idle");
  const errorKey = computed<Key>(() => result.value?.errorKey ?? FALLBACK_KEY);
  // Auch A/B/A innerhalb eines Ticks macht die alte Anfrage dauerhaft ungültig.
  watch(
    context,
    () => {
      result.value = null;
    },
    { flush: "sync" },
  );
  const disabledReason = computed<Key | null>(() => {
    if (!game.value || !scan.result || scan.status !== "done") return "drawer.prefixScanPending";
    if (scan.result.launchConfigStatus !== "available" || saving.value) {
      return "drawer.prefixUnchecked";
    }
    return hasExternalCompatdata(game.value.launchOptions) ? "drawer.prefixExternal" : null;
  });

  async function open(): Promise<void> {
    const current = game.value;
    if (!current || disabledReason.value || state.value === "opening") return;
    const request: PrefixResult = { state: "opening", errorKey: FALLBACK_KEY };
    result.value = request;
    let settled: PrefixResult = { ...request, state: "opened" };
    try {
      await openPrefixFolder(current.library, current.appId);
    } catch (error) {
      settled = {
        ...settled,
        state: "failed",
        errorKey: isErrorCode(error) ? ERROR_KEYS[error] : FALLBACK_KEY,
      };
    }
    // Nur die noch ausstehende Anfrage darf ihr Ergebnis eintragen.
    if (result.value === request) {
      result.value = settled;
    }
  }

  return { state, errorKey, disabledReason, open };
}
