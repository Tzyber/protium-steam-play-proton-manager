<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { openExternal, tauriPorts } from "../../core/adapters/tauri";
import { parseError } from "../../core/errtext";
import { analyzeLaunchOptions, type LaunchHint } from "../../core/launchHints";
import { protonDbAppUrl } from "../../core/protondb";
import type { LaunchConfigStatus, Tier } from "../../core/types";
import { focusFirstFocusable, restoreFocus, trapFocus } from "../a11y";
import type { ExplainTopic } from "../explain";
import { formatBytes, formatKnownBytes } from "../format";
import { formatError } from "../formatError";
import { t } from "../i18n";
import { useCleanupStore } from "../stores/cleanupStore";
import { useConfigStore } from "../stores/configStore";
import { useScanStore } from "../stores/scanStore";
import { useUiStore } from "../stores/uiStore";
import { tierName } from "../tier";
import { useCover } from "../useCover";
import { useGameFootprint } from "../useGameFootprint";
import { useLatestRequest } from "../useLatestRequest";
import { usePrefixOpen } from "../usePrefixOpen";
import { useSupportCopy } from "../useSupportCopy";
import BlockedExplanation from "./BlockedExplanation.vue";
import ExplainInfo from "./ExplainInfo.vue";
import PlayButton from "./PlayButton.vue";
import SelectBox from "./SelectBox.vue";
import TierBadge from "./TierBadge.vue";

const ui = useUiStore();
const config = useConfigStore();
const scan = useScanStore();
const cleanup = useCleanupStore();
// live-auflösung gegen den aktuellen scan-stand: nach einem rescan zeigt der
// drawer die frischen daten (z. B. direkt nach compat-tool-/startoptionen-write).
const game = computed(() => scan.result?.games.find((g) => g.appId === ui.selectedAppId) ?? null);

const {
  context: footprintContext,
  result: footprintResult,
  state: footprintState,
  invalidate: invalidateFootprint,
  measure: measureFootprint,
  partText: footprintPartText,
  summaryLabel: footprintSummaryLabel,
  summaryText: footprintSummaryText,
} = useGameFootprint(game, scan);

// fehlertext: einheitlich formatieren und uebersetzen (B1 Fehlersemantik).
function errorText(e: unknown): string {
  return formatError(e);
}

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

watch(
  game,
  async (current) => {
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
  invalidateFootprint();
  invalidateSupportCopy();
  if (toastTimer) clearTimeout(toastTimer);
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

// Status eines Speichervorgangs: bekannte schlagworte ODER die fehlermeldung.
// Als tagged union, damit `stateError` nicht aus einem freien string raten muss.
type SaveState =
  | { kind: "idle" | "saving" | "saved" }
  | { kind: "error"; message: string; uncertain: boolean };

const save = (kind: "idle" | "saving" | "saved"): SaveState => ({ kind });
// `uncertain` unterscheidet den Fall "möglicherweise geschrieben" (Code
// write-may-have-applied) vom belegten "nichts verändert": der Garantiesatz
// darf dort nicht stehen (SECURITY.md).
const saveError = (e: unknown): SaveState => ({
  kind: "error",
  message: formatError(e),
  uncertain: parseError(e).code === "write-may-have-applied",
});

// Status für das Speichern von Startoptionen.
const launchInput = ref("");
const launchState = ref<SaveState>(save("idle"));
const launchDirty = computed(() => launchInput.value !== (game.value?.launchOptions ?? ""));
const launchRequest = useLatestRequest(() => game.value);

watch(
  game,
  (g) => {
    launchInput.value = g?.launchOptions ?? "";
    launchState.value = save("idle");
  },
  { immediate: true },
);
watch(launchInput, () => {
  if (launchState.value.kind === "saved") launchState.value = save("idle");
});

function launchHintText(hint: LaunchHint): string {
  switch (hint) {
    case "gamemode-missing-command":
      return t("drawer.launchHintGamemodeMissingCommand");
    case "assignment-after-command":
      return t("drawer.launchHintAssignmentAfterCommand");
    case "assignment-without-command":
      return t("drawer.launchHintAssignmentWithoutCommand");
    case "proton-log-enabled":
      return t("drawer.launchHintProtonLogEnabled");
  }
}

const launchHints = computed(() => {
  const current = game.value;
  const result = scan.result;
  if (!current || !result || scan.status !== "done" || result.launchConfigStatus !== "available") {
    return [];
  }
  return analyzeLaunchOptions(launchInput.value).map(launchHintText);
});

const launchConfigUnavailable = computed(
  () =>
    scan.result?.launchConfigStatus !== undefined && scan.result.launchConfigStatus !== "available",
);

async function saveLaunch() {
  const g = game.value;
  if (!g || launchState.value.kind === "saving") return;
  // dirty-vergleich und gespeicherter wert laufen beide getrimmt, sonst bliebe
  // der save-button nach dem speichern von " foo " fälschlich aktiv.
  launchInput.value = launchInput.value.trim();
  if (!launchDirty.value) return;
  const token = launchRequest.begin();
  const submitted = launchInput.value;
  // ein abweichender entwurf beendet den status trotzdem, sonst bliebe der
  // knopf dauerhaft gesperrt.
  const stillMatches = (): boolean =>
    launchRequest.matchesValue(token, () => launchInput.value === submitted);
  launchState.value = save("saving");
  try {
    const result = await config.saveLaunchOptions(token.appId ?? g.appId, submitted);
    if (!launchRequest.matches(token)) return;
    if (!stillMatches()) {
      launchState.value = save("idle");
      return;
    }
    launchState.value = save(result === "written" ? "saved" : "idle");
  } catch (e) {
    if (!stillMatches()) return;
    launchState.value = saveError(e);
  }
}

// Auswahl und Status für Compat-Tools.
const compatSelected = ref("__default__");
const compatState = ref<SaveState>(save("idle"));
const compatRequest = useLatestRequest(() => game.value);

const compatProvenance = computed(() => {
  const result = scan.result;
  const current = game.value;
  if (!result || !current) return "";

  if (result.compatConfigStatus === "missing") return t("drawer.compatProvenanceMissing");
  if (result.compatConfigStatus === "unreadable") return t("drawer.compatProvenanceUnreadable");
  if (current.compatToolSource === "explicit") {
    return t("drawer.compatProvenanceExplicit", { name: current.compatTool });
  }
  if (current.compatToolSource === "default" && result.defaultCompatTool !== null) {
    return t("drawer.compatProvenanceDefault", { name: result.defaultCompatTool });
  }
  return t("drawer.compatProvenanceNoDefault");
});

const compatToolUnrecognized = computed(() =>
  scan.protonChecks.some(
    (check) => check.appId === game.value?.appId && check.reasons.includes("tool-not-recognized"),
  ),
);

const configTopics = computed<ExplainTopic[]>(() => {
  const topics: ExplainTopic[] = ["compat-tool", "compat-source"];
  const status = scan.result?.compatConfigStatus;
  if (status === "missing" || status === "unreadable") topics.push("config-unavailable");
  if (game.value?.compatToolSource === "default" && scan.result?.defaultCompatTool) {
    topics.push("global-default");
  }
  if (compatToolUnrecognized.value) topics.push("tool-unrecognized");
  return topics;
});

const footprintTopics = computed<ExplainTopic[]>(() =>
  footprintResult.value?.externalCompatdata ? ["footprint", "external-compatdata"] : ["footprint"],
);

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
  const customToolByDirectory = new Map(tools.map((tool) => [tool.name, tool]));
  if (
    current &&
    current !== "default" &&
    game.value?.compatToolSource === "explicit" &&
    !seen.has(current)
  ) {
    const customTool = customToolByDirectory.get(current);
    list.push({
      value: current,
      label: customTool?.displayName ?? t("drawer.notRecognized", { name: current }),
    });
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
    compatState.value = save("idle");
  },
  { immediate: true },
);

watch(compatSelected, () => {
  if (compatState.value.kind === "saved") compatState.value = save("idle");
});

async function saveCompat() {
  const g = game.value;
  if (!g || compatState.value.kind === "saving" || !compatDirty.value) return;
  const token = compatRequest.begin();
  const selected = compatSelected.value;
  const stillMatches = (): boolean =>
    compatRequest.matchesValue(token, () => compatSelected.value === selected);
  compatState.value = save("saving");
  try {
    const result = await config.saveCompatTool(
      token.appId ?? g.appId,
      selected === "__default__" ? null : selected,
    );
    if (!compatRequest.matches(token)) return;
    if (!stillMatches()) {
      compatState.value = save("idle");
      return;
    }
    compatState.value = save(result === "written" ? "saved" : "idle");
  } catch (e) {
    if (!stillMatches()) return;
    compatState.value = saveError(e);
  }
}

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

// fehler-toast: nur der fehlerfall trägt eine meldung.
function stateError(s: SaveState): string | null {
  return s.kind === "error" ? s.message : null;
}
const errorMessage = computed(() => stateError(compatState.value) ?? stateError(launchState.value));
const errorUncertain = computed(() => {
  const compat = compatState.value;
  if (compat.kind === "error") return compat.uncertain;
  const launch = launchState.value;
  return launch.kind === "error" ? launch.uncertain : false;
});
function dismissError() {
  if (stateError(compatState.value)) compatState.value = save("idle");
  if (stateError(launchState.value)) launchState.value = save("idle");
}

// toast nach 6s automatisch schließen (bleibt bei erneutem fehler frisch stehen).
let toastTimer: ReturnType<typeof setTimeout> | null = null;
watch(errorMessage, (msg) => {
  if (toastTimer) clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(dismissError, 6000);
});
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

        <div class="cover">
          <img v-if="cover" :src="cover" :alt="game.name" @error="onError" />
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
        <p class="meta mono">{{ formatBytes(game.sizeBytes) }} · appid - {{ game.appId }}</p>
        <p class="meta-tier">
          {{ tierName(game.protonDb?.tier ?? "unknown") }}
          <ExplainInfo
            :label="t('explain.topics.protondb.title')"
            :topics="['protondb']"
            :context-key="game.appId"
          />
        </p>

        <PlayButton variant="full" :appId="game.appId" :name="game.name" />

        <div class="support-actions">
          <button
            class="save"
            data-testid="support-copy"
            type="button"
            :disabled="!canCopySupport"
            @click="copySupport"
          >
            {{
              supportCopyState === "copying"
                ? t("drawer.supportCopying")
                : supportCopyState === "copied"
                  ? t("drawer.supportCopied")
                  : t("drawer.supportCopy")
            }}
          </button>
          <p
            v-if="supportCopyState === 'copied'"
            class="hint support-copy-status"
            data-testid="support-copy-status"
            role="status"
            aria-live="polite"
          >
            {{ t("drawer.supportCopied") }}
          </p>
          <p
            v-else-if="supportCopyState === 'failed'"
            class="hint support-copy-status"
            data-testid="support-copy-error"
            role="alert"
          >
            {{ t("drawer.supportCopyError") }}
          </p>
        </div>

        <section
          class="footprint"
          data-testid="footprint-section"
          :aria-busy="footprintState === 'measuring'"
        >
          <div class="section-label-explained">
            <h3 class="section-label">{{ t("drawer.footprintTitle") }}</h3>
            <ExplainInfo
              :label="t('drawer.footprintTitle')"
              :topics="footprintTopics"
              :context-key="game.appId"
            />
          </div>
          <p v-if="footprintState === 'idle'" class="hint">
            {{ t("drawer.footprintExplanation") }}
          </p>
          <button
            class="save footprint-measure"
            data-testid="footprint-measure"
            type="button"
            :disabled="footprintState === 'measuring'"
            @click="measureFootprint"
          >
            {{
              footprintState === "measuring"
                ? t("drawer.footprintMeasuring")
                : t("drawer.footprintMeasure")
            }}
          </button>

          <div v-if="footprintState !== 'idle'" class="footprint-values">
            <div class="footprint-row" data-testid="footprint-game-install">
              <span class="k">{{ t("drawer.footprintGameFiles") }}</span>
              <span data-testid="footprint-game-install-value">{{
                footprintPartText(footprintResult?.gameInstall)
              }}</span>
            </div>
            <div class="footprint-row" data-testid="footprint-compatdata">
              <span class="k">{{ t("drawer.footprintCompatdata") }}</span>
              <span data-testid="footprint-compatdata-value">{{
                footprintPartText(footprintResult?.compatdata)
              }}</span>
            </div>
            <div class="footprint-row" data-testid="footprint-shadercache">
              <span class="k">{{ t("drawer.footprintShadercache") }}</span>
              <span data-testid="footprint-shadercache-value">{{
                footprintPartText(footprintResult?.shadercache)
              }}</span>
            </div>

            <div
              v-if="footprintState === 'measuring'"
              class="footprint-row footprint-summary"
              data-testid="footprint-summary"
            >
              <span class="k">{{ t("drawer.footprintSummaryLabel") }}</span>
              <span>{{ footprintSummaryText() }}</span>
            </div>
            <p
              v-else-if="footprintResult?.summary.status === 'not-measured'"
              class="hint footprint-summary"
              data-testid="footprint-summary"
            >
              {{ t("common.notMeasured") }}
            </p>
            <div v-else class="footprint-row footprint-summary" data-testid="footprint-summary">
              <span class="k">{{ footprintSummaryLabel(footprintResult?.summary ?? { status: "not-measured" }) }}</span>
              <span>{{ footprintSummaryText() }}</span>
            </div>

            <p
              v-if="footprintResult?.externalCompatdata"
              class="hint"
              data-testid="footprint-external-compatdata"
            >
              {{ t("drawer.footprintExternalCompatdata") }}
            </p>
            <p
              v-if="footprintResult?.compatdataNotChecked"
              class="hint"
              data-testid="footprint-compatdata-not-checked"
            >
              {{ t("drawer.footprintCompatdataNotChecked") }}
            </p>
          </div>
        </section>

        <div class="divider" />
        <div class="section-label-explained">
          <p class="section-label mono">{{ t("drawer.configuration") }}</p>
          <ExplainInfo
            :label="t('drawer.configuration')"
            :topics="configTopics"
            :context-key="game.appId"
          />
        </div>

        <div class="field">
          <label class="k" for="compat-tool">{{ t("drawer.compatToolLabel") }}</label>
          <div class="field-row">
            <SelectBox id="compat-tool" v-model="compatSelected" :options="compatOptions" />
            <button
              class="save"
              type="button"
              :disabled="!compatDirty || compatState.kind === 'saving'"
              @click="saveCompat"
            >
              {{
                compatState.kind === "saving"
                  ? "…"
                  : compatState.kind === "saved"
                    ? t("drawer.saved")
                    : t("drawer.save")
              }}
            </button>
          </div>
          <p class="hint" data-testid="compat-provenance">
            {{ compatProvenance }}
          </p>
          <p v-if="compatToolUnrecognized" class="hint" data-testid="compat-unrecognized">
            {{ t("drawer.compatToolUnrecognized") }}
          </p>
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
              :disabled="!launchDirty || launchState.kind === 'saving'"
              @click="saveLaunch"
            >
              {{
                launchState.kind === "saving"
                  ? "…"
                  : launchState.kind === "saved"
                    ? t("drawer.saved")
                    : t("drawer.save")
              }}
            </button>
          </div>
          <p class="hint">{{ t("drawer.launchOptionsHint") }}</p>
          <p v-if="launchConfigUnavailable" class="hint" data-testid="launch-config-unavailable">
            {{ t("drawer.launchOptionsUnavailable") }}
          </p>
          <ul
            v-if="launchHints.length"
            class="launch-hints"
            data-testid="launch-hints"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <li v-for="hint in launchHints" :key="hint">{{ hint }}</li>
          </ul>
        </div>

        <div class="prefix-actions" :aria-busy="prefixState === 'opening'">
          <button
            class="save"
            data-testid="prefix-open"
            type="button"
            :disabled="prefixDisabledReason !== null || prefixState === 'opening'"
            :aria-describedby="prefixDisabledReason ? 'prefix-disabled-reason' : undefined"
            @click="openPrefix"
          >
            {{ t(prefixState === 'opening' ? 'drawer.prefixOpening' : 'drawer.prefixOpen') }}
          </button>
          <p v-if="prefixDisabledReason" id="prefix-disabled-reason" class="hint" data-testid="prefix-reason" role="status">{{ t(prefixDisabledReason) }}</p>
          <p v-if="prefixState === 'opened' || prefixState === 'failed'" class="hint" data-testid="prefix-status" :role="prefixState === 'failed' ? 'alert' : 'status'">{{ t(prefixState === 'opened' ? 'drawer.prefixOpened' : prefixErrorKey) }}</p>
        </div>

        <div class="divider" />

        <a class="pdb-link mono" :href="game ? protonDbAppUrl(game.appId) : '#'" @click.prevent="openProtonDb">
          {{ game?.protonDb?.tier === "unknown" ? t("drawer.protondbLookup") : t("drawer.protondbLink") }}
        </a>
        <p class="hint">{{ t("drawer.protondbHint") }}</p>

        <!-- Ablehnung im B2-Muster: Titel, Pruefbericht, Garantiesatz -->
        <BlockedExplanation
          v-if="errorMessage"
          class="drawer-blocked"
          :title="t('drawer.saveBlocked')"
          :intro="t('common.couldNotVerify')"
          :items="[errorMessage]"
          :guarantee="errorUncertain ? t('drawer.saveUncertain') : t('common.nothingChanged')"
        />
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
  width: min(420px, 92vw);
  background: var(--bg-1);
  border-left: 1px solid var(--line);
  box-shadow: -24px 0 60px -20px rgba(0, 0, 0, 0.6);
  padding: 20px 22px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.close {
  position: absolute; top: 8px; right: 8px;
  width: 44px; height: 44px;
  background: none; border: none; color: var(--fg-2);
  font-size: 0.9375rem; cursor: pointer; z-index: 2;
  padding: 0; display: grid; place-items: center;
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
.prefix-actions { margin-top: 10px; }
.support-actions { margin-top: 16px; }
.support-copy-status { margin-bottom: 0; }

.footprint { margin-top: 20px; }
.footprint .section-label { margin-bottom: 10px; }
.footprint-measure { margin-top: 12px; }
.footprint-values { margin-top: 18px; }
.footprint-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  min-height: 28px;
  color: var(--fg-0);
  font-size: 0.8125rem;
}
.footprint-row .k { margin: 0; color: var(--fg-1); }
.footprint-summary {
  border-top: 1px solid var(--line-soft);
  margin-top: 8px;
  padding-top: 10px;
  font-weight: 600;
}
.footprint-summary .k { color: var(--fg-0); }
.footprint .hint { margin-top: 12px; }

.section-label-explained {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.section-label-explained .section-label {
  margin-bottom: 0;
}

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
.save:focus-visible, .close:focus-visible, .toast-close:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
}

.hint { margin: 9px 2px 0; color: var(--fg-2); font-size: 0.8125rem; line-height: 1.55; }
.launch-hints {
  margin: 9px 2px 0;
  padding-left: 18px;
  color: var(--fg-2);
  font-size: 0.8125rem;
  line-height: 1.55;
}

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
  flex-shrink: 0; width: 32px; height: 32px;
  background: none; border: none; color: var(--fg-2);
  font-size: 0.75rem; cursor: pointer; padding: 0; line-height: 1;
  display: grid; place-items: center;
}
.toast-close:hover { color: var(--fg-0); }
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-6px); }

.drawer-enter-active .drawer, .drawer-leave-active .drawer { transition: transform 0.2s ease; }
.drawer-enter-from .drawer, .drawer-leave-to .drawer { transform: translateX(100%); }
</style>
