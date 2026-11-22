<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { protonDbAppUrl } from "../../core/protondb";
import { focusFirstFocusable, restoreFocus, trapFocus } from "../a11y";
import { useCover } from "../composables/useCover";
import { type SaveState, useGameConfigSave } from "../composables/useGameConfigSave";
import { useGameFootprint } from "../composables/useGameFootprint";
import { usePrefixOpen } from "../composables/usePrefixOpen";
import { useSupportCopy } from "../composables/useSupportCopy";
import type { ExplainTopic } from "../explain";
import { formatBytes } from "../format";
import { formatError } from "../formatError";
import {
  compatOptions as buildCompatOptions,
  configTopics as buildConfigTopics,
  compatProvenance as deriveCompatProvenance,
  launchHints as deriveLaunchHints,
  compatToolUnrecognized as isCompatToolUnrecognized,
  launchConfigUnavailable as isLaunchConfigUnavailable,
} from "../gameConfig";
import { t } from "../i18n";
import { ports } from "../ports";
import { useCleanupStore } from "../stores/cleanupStore";
import { useConfigStore } from "../stores/configStore";
import { useScanStore } from "../stores/scanStore";
import { useUiStore } from "../stores/uiStore";
import BlockedExplanation from "./BlockedExplanation.vue";
import GameConfigSection from "./GameConfigSection.vue";
import GameDetailHeader from "./GameDetailHeader.vue";
import GameFootprintSection from "./GameFootprintSection.vue";

const ui = useUiStore();
const config = useConfigStore();
const scan = useScanStore();
const cleanup = useCleanupStore();
// live-auflösung gegen den aktuellen scan-stand: nach einem rescan zeigt der
// drawer die frischen daten (z. B. direkt nach compat-tool-/startoptionen-write).
const game = computed(() => scan.result?.games.find((g) => g.appId === ui.selectedAppId) ?? null);

const footprint = useGameFootprint(game, scan);
const { invalidate: invalidateFootprint, result: footprintResult } = footprint;

// cover-kandidaten wie in der karte
const { src: cover, onError } = useCover(() => game.value);

const drawerRef = ref<HTMLElement | null>(null);
const titleId = "game-detail-title";
const descriptionId = "game-detail-description";
let lastFocusedElement: HTMLElement | null = null;

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    ui.closeGame();
    return;
  }

  trapFocus(event, drawerRef.value);
}

// nur der appId-tausch ist ein spielwechsel. ein rescan ersetzt den snapshot
// und damit das spiel-objekt bei gleicher appId; dann darf weder der fokus
// springen noch der entwurf verfallen (der liegt in useGameConfigSave).
watch(
  () => game.value?.appId ?? null,
  async (appId) => {
    if (appId !== null) {
      lastFocusedElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      focusFirstFocusable(drawerRef.value);
      return;
    }

    await nextTick();
    // nur zurückspringen, wenn beim öffnen ein element gespeichert wurde
    // sonst greift restoreFocus(null) über die fallback-kette auf den
    // sidebar-nav-button und klaut den fokus direkt nach dem mount
    // (watch läuft mit immediate: true einmal mit null durch).
    if (lastFocusedElement) restoreFocus(lastFocusedElement);
    lastFocusedElement = null;
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  invalidateFootprint();
  invalidateSupportCopy();
  restoreFocus(lastFocusedElement);
});

async function openProtonDb() {
  if (game.value) {
    await ports.system.openExternal(protonDbAppUrl(game.value.appId)).catch((e: unknown) => {
      // kein stilles scheitern: fehler als notification sichtbar machen
      ui.showNotification(t("drawer.protondbOpenFailed", { error: formatError(e) }));
    });
  }
}

// Startoptionen- und Compat-Feld samt Speicherstatus: die beiden Schreibpfade
// waren bis auf das Feld wortgleich und liegen jetzt in einem Baustein.
const {
  launchInput,
  launchState,
  launchDirty,
  saveLaunch,
  compatSelected,
  compatState,
  compatDirty,
  saveCompat,
} = useGameConfigSave(game, config);

const launchHints = computed(() =>
  deriveLaunchHints(launchInput.value, game.value, scan.result, scan.status),
);

const launchConfigUnavailable = computed(() => isLaunchConfigUnavailable(scan.result));

const compatProvenance = computed(() => deriveCompatProvenance(scan.result, game.value));

const compatToolUnrecognized = computed(() =>
  isCompatToolUnrecognized(game.value, scan.protonChecks),
);

const configTopics = computed<ExplainTopic[]>(() =>
  buildConfigTopics(scan.result, game.value, compatToolUnrecognized.value),
);

const compatOptions = computed(() => buildCompatOptions(scan.result, game.value));

const {
  state: supportCopyState,
  canCopy: canCopySupport,
  invalidate: invalidateSupportCopy,
  copy: copySupport,
} = useSupportCopy(
  game,
  scan,
  footprintResult,
  cleanup,
  computed(() => launchState.value.kind === "saving" || compatState.value.kind === "saving"),
);

const {
  state: prefixState,
  errorKey: prefixErrorKey,
  disabledReason: prefixDisabledReason,
  open: openPrefix,
} = usePrefixOpen(
  game,
  computed(() => launchState.value.kind === "saving"),
);

// inline-fehler im drawer (der frühere toast ist weg): nur der fehlerfall trägt eine meldung.
function stateError(s: SaveState): string | null {
  return s.kind === "error" ? s.message : null;
}
// beide schreibpfade können gleichzeitig im fehlerland stehen. die meldung
// zeigt jeden fehler (reihenfolge wie im formular: compat über startoptionen),
// sonst verdeckte der eine den anderen (N-4).
const errorItems = computed(() =>
  [compatState.value, launchState.value]
    .map(stateError)
    .filter((message): message is string => message !== null),
);
// der garantiesatz gilt nur, wenn kein einziger zustand einen unsicheren
// schreibausgang trägt: ein zweiter, sicherer fehler darf „nichts wurde
// verändet" nicht freigeben, obwohl ein anderer vorgang womöglich griff (N-4).
const hasUncertainError = computed(() =>
  [compatState.value, launchState.value].some((s) => s.kind === "error" && s.uncertain),
);
// der fehler bleibt stehen, bis der nutzer ihn schließt: ein fehlgeschlagener
// schreibvorgang darf nicht unbemerkt verschwinden (U-02).
function dismissError() {
  if (stateError(compatState.value)) compatState.value = { kind: "idle" };
  if (stateError(launchState.value)) launchState.value = { kind: "idle" };
  // der knopf verschwindet mit der meldung; ohne umzug fiele der fokus auf body
  // und der dialog hätte kein fokusziel mehr.
  drawerRef.value?.focus();
}
</script>

<template>
  <Teleport to="body">
    <transition name="drawer">
      <div v-if="game" class="wrap">
      <div class="scrim" @click="ui.closeGame()" />
      <aside
        ref="drawerRef"
        class="drawer"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="descriptionId"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <button class="close" type="button" :aria-label="t('drawer.close')" @click="ui.closeGame()"><span aria-hidden="true">✕</span></button>

        <p :id="descriptionId" class="sr-only">
          {{ t("drawer.srDescription", { name: game.name, size: formatBytes(game.sizeBytes), compatTool: game.compatTool, appId: game.appId }) }}
        </p>

        <GameDetailHeader
          :game="game"
          :title-id="titleId"
          :cover="cover"
          :proton-db-loading="game.protonDb === null && scan.protonDbRemaining > 0"
          :support-copy-state="supportCopyState"
          :can-copy-support="canCopySupport"
          @cover-error="onError"
          @copy-support="copySupport"
        />

        <GameFootprintSection :footprint="footprint" :app-id="game.appId" />

        <GameConfigSection
          v-model:compat-selected="compatSelected"
          v-model:launch-input="launchInput"
          :app-id="game.appId"
          :config-topics="configTopics"
          :compat-options="compatOptions"
          :compat-state="compatState"
          :compat-dirty="compatDirty"
          :compat-provenance="compatProvenance"
          :compat-tool-unrecognized="compatToolUnrecognized"
          :launch-state="launchState"
          :launch-dirty="launchDirty"
          :launch-config-unavailable="launchConfigUnavailable"
          :launch-hints="launchHints"
          :prefix-state="prefixState"
          :prefix-error-key="prefixErrorKey"
          :prefix-disabled-reason="prefixDisabledReason"
          @save-compat="saveCompat"
          @save-launch="saveLaunch"
          @open-prefix="openPrefix"
        />

        <div class="divider" />

        <a class="pdb-link mono" :href="game ? protonDbAppUrl(game.appId) : '#'" @click.prevent="openProtonDb">
          {{ game?.protonDb?.tier === "unknown" ? t("drawer.protondbLookup") : t("drawer.protondbLink") }}
        </a>
        <p class="hint">{{ t("drawer.protondbHint") }}</p>

        <!-- Ablehnung im B2-Muster: Titel, Pruefbericht, Garantiesatz -->
        <div v-if="errorItems.length" class="drawer-error">
          <BlockedExplanation
            class="drawer-blocked"
            :title="t('drawer.saveBlocked')"
            :intro="t('common.couldNotVerify')"
            :items="errorItems"
            :guarantee="hasUncertainError ? t('drawer.saveUncertain') : t('common.nothingChanged')"
          />
          <button
            class="drawer-error-close"
            data-testid="drawer-error-close"
            type="button"
            :aria-label="t('drawer.dismissError')"
            @click="dismissError"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </aside>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.wrap { position: fixed; inset: 0; z-index: 40; }
.scrim { position: absolute; inset: 0; background: rgba(4, 5, 9, 0.55); }
.drawer {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: min(var(--drawer-w), 100vw);
  background: var(--bg-1);
  border-left: 1px solid var(--line);
  box-shadow: -24px 0 60px -20px rgba(0, 0, 0, 0.6);
  padding: var(--space-5);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.close {
  position: absolute; top: 8px; right: 8px;
  width: 44px; height: 44px;
  background: none; border: none; color: var(--fg-2);
  font-size: var(--text-lg); cursor: pointer; z-index: 2;
  padding: 0; display: grid; place-items: center;
}
.close:hover { color: var(--fg-0); }

.divider { height: 1px; background: var(--line-soft); margin: var(--space-5) 0 var(--space-4); }

.close:focus-visible, .drawer-error-close:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
}

.pdb-link {
  display: inline-block;
  color: var(--signal-bright);
  font-size: var(--text-md);
  font-weight: 700;
  text-decoration: none;
  transition: color 0.15s;
}
.pdb-link:hover { color: var(--signal); text-decoration: underline; }

.drawer-error {
  position: relative;
  /* platz für den absolut positionierten schließen-knopf, sonst laufen lange
     titel/lokalisierungen darunter. */
  padding-right: var(--space-7);
}
.drawer-error-close {
  position: absolute; top: 8px; right: 8px;
  width: 32px; height: 32px;
  background: none; border: none; color: var(--fg-2);
  font-size: var(--text-xs); cursor: pointer; padding: 0; line-height: 1;
  display: grid; place-items: center;
}
.drawer-error-close:hover { color: var(--fg-0); }

.drawer-enter-active .drawer, .drawer-leave-active .drawer { transition: transform 0.2s ease; }
.drawer-enter-from .drawer, .drawer-leave-to .drawer { transform: translateX(100%); }
</style>
