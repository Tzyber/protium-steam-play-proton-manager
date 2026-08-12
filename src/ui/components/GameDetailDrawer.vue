<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { assetUrl, openExternal } from "../../core/adapters/tauri";
import { SteamRunningError } from "../../core/configwrite";
import { protonDbAppUrl } from "../../core/protondb";
import type { Tier } from "../../core/types";
import { focusFirstFocusable, restoreFocus, trapFocus } from "../a11y";
import { errMsg, formatBytes } from "../format";
import { t } from "../i18n";
import { useConfigStore } from "../stores/configStore";
import { useScanStore } from "../stores/scanStore";
import { useUiStore } from "../stores/uiStore";
import PlayButton from "./PlayButton.vue";
import SelectBox from "./SelectBox.vue";
import TierBadge from "./TierBadge.vue";

const ui = useUiStore();
const config = useConfigStore();
const scan = useScanStore();
// live-auflösung gegen den aktuellen scan-stand: nach einem rescan zeigt der
// drawer die frischen daten (z. B. direkt nach compat-tool-/startoptionen-write).
const game = computed(() => scan.result?.games.find((g) => g.appId === ui.selectedAppId) ?? null);

// tier-labels: t() in einem object, damit wir pro tier den lokalisierten text haben.
// (reactive weil t() selbst zustandslos ist, aber für saubere template-usage als
// computed.)
const TIER_LABEL = computed<Record<Tier, string>>(() => ({
  platinum: t("tier.platinum"),
  gold: t("tier.gold"),
  silver: t("tier.silver"),
  bronze: t("tier.bronze"),
  borked: t("tier.borked"),
  unknown: t("tier.unknown"),
}));

// fehlertext: SteamRunningError bekommt die übersetzte meldung, andere rohe errors
// (z. b. schreibrechte) bleiben unverändert, weil sie aus dem system kommen.
function errorText(e: unknown): string {
  if (e instanceof SteamRunningError) return t("errors.steamRunning");
  return errMsg(e);
}

// cover-kandidaten wie in der karte
const idx = ref(0);
const cover = computed<string | null>(() => {
  const g = game.value;
  if (!g) return null;
  const list: string[] = [];
  if (g.localHeader) list.push(assetUrl(g.localHeader));
  if (g.headerImage) list.push(g.headerImage);
  return list[idx.value] ?? null;
});

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

watch(
  game,
  async (current) => {
    ui.inertMain = !!current;
    if (current) {
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
  if (toastTimer) clearTimeout(toastTimer);
  ui.inertMain = false;
  restoreFocus(lastFocusedElement);
});

async function openProtonDb() {
  if (game.value) {
    await openExternal(protonDbAppUrl(game.value.appId)).catch((e: unknown) => {
      // kein stilles scheitern: fehler als notification sichtbar machen
      ui.showNotification(t("drawer.protondbOpenFailed", { error: errorText(e) }));
    });
  }
}

// startoptionen (phase 4): "idle" | "saving" | "saved" | fehlermeldung
const launchInput = ref("");
const launchState = ref<"idle" | "saving" | "saved" | string>("idle");
const launchDirty = computed(() => launchInput.value !== (game.value?.launchOptions ?? ""));

watch(
  game,
  (g) => {
    // cover-fehler-index zurücksetzen: ohne das erbt das nächste spiel den
    // fallback-stand des vorherigen und zeigt trotz vorhandenem cover nur text.
    idx.value = 0;
    launchInput.value = g?.launchOptions ?? "";
    launchState.value = "idle";
  },
  { immediate: true },
);
watch(launchInput, () => {
  if (launchState.value === "saved") launchState.value = "idle";
});

async function saveLaunch() {
  const g = game.value;
  if (!g || launchState.value === "saving") return;
  // dirty-vergleich und gespeicherter wert laufen beide getrimmt, sonst bliebe
  // der save-button nach dem speichern von " foo " fälschlich aktiv.
  launchInput.value = launchInput.value.trim();
  if (!launchDirty.value) return;
  launchState.value = "saving";
  try {
    await config.saveLaunchOptions(g.appId, launchInput.value);
    launchState.value = "saved";
  } catch (e) {
    launchState.value = errorText(e);
  }
}

// compat-tool-dropdown (phase 4, schritt 5)
const compatSelected = ref("__default__");
const compatState = ref<"idle" | "saving" | "saved" | string>("idle");

const compatOptions = computed(() => {
  const builtIns = scan.result?.builtinProtonsInstalled ?? [];
  const tools = scan.result?.compatToolsInstalled ?? [];
  const current = game.value?.compatTool ?? "";
  const list: { value: string; label: string }[] = [];

  list.push({ value: "__default__", label: t("drawer.compatDefault") });

  for (const t of builtIns) {
    list.push({ value: t.internalName, label: t.displayName });
  }

  for (const t of tools) {
    list.push({ value: t.internalName, label: t.displayName });
  }

  const seen = new Set(list.map((o) => o.value));
  if (current && current !== "default" && !seen.has(current)) {
    list.push({ value: current, label: t("drawer.notInstalled", { name: current }) });
  }

  return list;
});

const compatDirty = computed(() => {
  const current = game.value?.compatTool ?? "default";
  const expected = current === "default" ? "__default__" : current;
  return compatSelected.value !== expected;
});

watch(
  game,
  (g) => {
    const tool = g?.compatTool;
    compatSelected.value = tool && tool !== "default" ? tool : "__default__";
    compatState.value = "idle";
  },
  { immediate: true },
);

watch(compatSelected, () => {
  if (compatState.value === "saved") compatState.value = "idle";
});

async function saveCompat() {
  const g = game.value;
  if (!g || compatState.value === "saving" || !compatDirty.value) return;
  compatState.value = "saving";
  try {
    const name = compatSelected.value === "__default__" ? null : compatSelected.value;
    await config.saveCompatTool(g.appId, name);
    compatState.value = "saved";
  } catch (e) {
    compatState.value = errorText(e);
  }
}

// fehler-toast: der state ist entweder ein bekanntes schlagwort oder die fehlermeldung.
function stateError(s: string): string | null {
  return s === "idle" || s === "saving" || s === "saved" ? null : s;
}
const errorMessage = computed(() => stateError(compatState.value) ?? stateError(launchState.value));
function dismissError() {
  if (stateError(compatState.value)) compatState.value = "idle";
  if (stateError(launchState.value)) launchState.value = "idle";
}

// toast nach 6s automatisch schließen (bleibt bei erneutem fehler frisch stehen).
let toastTimer: ReturnType<typeof setTimeout> | null = null;
watch(errorMessage, (msg) => {
  if (toastTimer) clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(dismissError, 6000);
});
</script>

<template>
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

        <div class="cover">
          <img v-if="cover" :src="cover" :alt="game.name" @error="idx++" />
          <div v-else class="cover-fb"><span>{{ game.name }}</span></div>
        </div>

        <div class="head">
          <h2 :id="titleId">{{ game.name }}</h2>
          <TierBadge
            v-if="game.protonDb"
            :tier="game.protonDb.tier"
            :confidence="game.protonDb.confidence"
          />
        </div>
        <p class="meta mono">{{ formatBytes(game.sizeBytes) }} · appid -  {{ game.appId }}</p>
        <p class="meta-tier">{{ TIER_LABEL[game.protonDb?.tier ?? "unknown"] }}</p>

        <PlayButton variant="full" :appId="game.appId" :name="game.name" />

        <div class="divider" />
        <p class="section-label mono">{{ t("drawer.configuration") }}</p>

        <div class="field">
          <label class="k" for="compat-tool">{{ t("drawer.compatToolLabel") }}</label>
          <div class="field-row">
            <SelectBox id="compat-tool" v-model="compatSelected" :options="compatOptions" />
            <button
              class="save"
              type="button"
              :disabled="!compatDirty || compatState === 'saving'"
              @click="saveCompat"
            >
              {{ compatState === "saving" ? "…" : compatState === "saved" ? t("drawer.saved") : t("drawer.save") }}
            </button>
          </div>
        </div>

        <div class="field">
          <label class="k" for="launch-options">{{ t("drawer.launchOptionsLabel") }}</label>
          <div class="field-row">
            <input
              id="launch-options"
              v-model="launchInput"
              type="text"
              class="control mono"
              :placeholder="t('drawer.launchOptionsPlaceholder')"
              spellcheck="false"
              @keydown.enter="saveLaunch"
            />
            <button
              class="save"
              type="button"
              :disabled="!launchDirty || launchState === 'saving'"
              @click="saveLaunch"
            >
              {{ launchState === "saving" ? "…" : launchState === "saved" ? t("drawer.saved") : t("drawer.save") }}
            </button>
          </div>
          <p class="hint">{{ t("drawer.launchOptionsHint") }}</p>
        </div>

        <div class="divider" />

        <a class="pdb-link mono" :href="game ? protonDbAppUrl(game.appId) : '#'" @click.prevent="openProtonDb">
          {{ t("drawer.protondbLink") }}
        </a>
        <p class="hint">{{ t("drawer.protondbHint") }}</p>

        <!-- fehler-toast: oben fixiert im drawer, direkt im blick der eingaben -->
        <transition name="toast">
          <div v-if="errorMessage" class="toast" role="alert">
            <span class="toast-icon" aria-hidden="true">⚠</span>
            <span class="toast-msg">{{ errorMessage }}</span>
            <button class="toast-close" type="button" :aria-label="t('drawer.dismissError')" @click="dismissError">✕</button>
          </div>
        </transition>
      </aside>
    </div>
  </transition>
</template>

<style scoped>
.wrap { position: fixed; inset: 0; z-index: 40; }
.scrim { position: absolute; inset: 0; background: rgba(4, 5, 9, 0.55); }
.drawer {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: min(420px, 92vw);
  background: var(--bg-1);
  border-left: 1px solid var(--line);
  box-shadow: -24px 0 60px -20px rgba(0, 0, 0, 0.6);
  padding: 20px 22px;
  overflow-y: auto;
}

.close {
  position: absolute; top: 14px; right: 16px;
  background: none; border: none; color: var(--fg-2);
  font-size: 0.9375rem; cursor: pointer; z-index: 2;
  min-width: 24px; min-height: 24px; display: grid; place-items: center;
}
.close:hover { color: var(--fg-0); }

.cover {
  aspect-ratio: 460 / 215;
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--bg-3);
  margin-bottom: 14px;
}
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover-fb {
  width: 100%; height: 100%; display: grid; place-items: center; padding: 12px; text-align: center;
  background: linear-gradient(135deg, var(--bg-3), var(--bg-1));
  font-family: var(--font-display); font-weight: 600; color: var(--fg-1);
}

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.head h2 { margin: 0; font-family: var(--font-display); font-size: 1.3125rem; font-weight: 600; letter-spacing: -0.02em; }
.head :deep(*) { flex-shrink: 0; }
.meta { margin: 6px 0 2px; color: var(--fg-2); font-size: 0.875rem; }
.meta-tier { margin: 0 0 20px; color: var(--fg-1); font-size: 0.875rem; line-height: 1.5; }

.divider { height: 1px; background: var(--line-soft); margin: 20px 0 16px; }
.section-label {
  margin: 0 0 14px;
  font-size: 0.75rem;
  letter-spacing: 0.14em;
  color: var(--fg-1);
  text-transform: uppercase;
}

.field { margin-bottom: 16px; }
.k { display: block; color: var(--fg-1); font-size: 0.875rem; margin-bottom: 7px; }
.field-row { display: flex; gap: 8px; }
.control {
  flex: 1;
  min-width: 0;
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg-0);
  border-radius: var(--r-sm);
  padding: 11px 13px;
  font-size: 0.8125rem;
}
.control:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; border-color: var(--signal-dim); }

.save {
  flex-shrink: 0;
  background: var(--bg-2);
  border: 1px solid var(--signal-dim);
  color: var(--signal-bright);
  border-radius: var(--r-sm);
  padding: 11px 15px;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 0.875rem;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s;
}
.save:hover:not(:disabled) { background: var(--bg-3); border-color: var(--signal); }
.save:disabled { opacity: 0.4; cursor: default; }

.hint { margin: 9px 2px 0; color: var(--fg-2); font-size: 0.8125rem; line-height: 1.55; }

.pdb-link {
  display: inline-block;
  color: var(--signal-bright);
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
  transition: color 0.15s;
}
.pdb-link:hover { color: var(--signal); text-decoration: underline; }

.toast {
  position: sticky;
  top: 8px;
  z-index: 3;
  margin: 12px 0 0;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  background: var(--bg-2);
  border: 1px solid var(--tier-borked);
  border-radius: var(--r-sm);
  padding: 11px 13px;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.6);
}
.toast-icon { color: var(--tier-borked); font-size: 0.875rem; flex-shrink: 0; margin-top: 1px; }
.toast-msg { flex: 1; color: var(--fg-0); font-size: 0.84375rem; line-height: 1.5; }
.toast-close {
  flex-shrink: 0; background: none; border: none; color: var(--fg-2);
  font-size: 0.75rem; cursor: pointer; padding: 0; line-height: 1;
  min-width: 24px; min-height: 24px; display: grid; place-items: center;
}
.toast-close:hover { color: var(--fg-0); }
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-6px); }

.drawer-enter-active .drawer, .drawer-leave-active .drawer { transition: transform 0.2s ease; }
.drawer-enter-from .drawer, .drawer-leave-to .drawer { transform: translateX(100%); }
</style>
