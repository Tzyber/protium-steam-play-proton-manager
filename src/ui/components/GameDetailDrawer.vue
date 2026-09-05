<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { version as appVersion } from "../../../package.json";
import { openExternal, tauriPorts } from "../../core/adapters/tauri";
import { SteamRunningError } from "../../core/configwrite";
import { errText } from "../../core/errtext";
import {
  type FootprintPart,
  type GameFootprint,
  hasExternalCompatdata,
  measureGameFootprint,
} from "../../core/footprint";
import { analyzeLaunchOptions, type LaunchHint } from "../../core/launchHints";
import { protonDbAppUrl } from "../../core/protondb";
import { projectSupportFacts } from "../../core/support";
import type { LaunchConfigStatus, Tier } from "../../core/types";
import { focusFirstFocusable, restoreFocus, trapFocus } from "../a11y";
import { formatBytes } from "../format";
import { t } from "../i18n";
import { useCleanupStore } from "../stores/cleanupStore";
import { useConfigStore } from "../stores/configStore";
import { useScanStore } from "../stores/scanStore";
import { useUiStore } from "../stores/uiStore";
import { formatSupportFacts } from "../supportText";
import { useCover } from "../useCover";
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

type FootprintUiState = "idle" | "measuring" | "ready";

interface FootprintContext {
  appId: number;
  scanGeneration: number;
  library: string;
  installdir: string | undefined;
  launchConfigStatus: LaunchConfigStatus;
  externalCompatdata: boolean;
  compatdataNotChecked: boolean;
}

const footprintContext = computed<FootprintContext | null>(() => {
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

const footprintResult = ref<GameFootprint | null>(null);
const footprintState = ref<FootprintUiState>("idle");
let footprintRequestId = 0;

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

function invalidateFootprint(): void {
  footprintRequestId += 1;
  footprintResult.value = null;
  footprintState.value = "idle";
}

watch(
  footprintContext,
  (current, previous) => {
    if (previous === undefined || !sameFootprintContext(current, previous)) {
      invalidateFootprint();
    }
  },
  { immediate: true },
);

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

function isCurrentFootprintRequest(requestId: number, context: FootprintContext): boolean {
  return requestId === footprintRequestId && sameFootprintContext(footprintContext.value, context);
}

async function measureFootprint(): Promise<void> {
  const current = game.value;
  const result = scan.result;
  const context = footprintContext.value;
  if (!current || !result || !context || footprintState.value === "measuring") return;

  const requestId = ++footprintRequestId;
  footprintResult.value = null;
  footprintState.value = "measuring";
  try {
    const measured = await measureGameFootprint(
      tauriPorts.system,
      current,
      result.launchConfigStatus,
    );
    if (!isCurrentFootprintRequest(requestId, context)) return;
    footprintResult.value = measured;
    footprintState.value = "ready";
  } catch {
    if (!isCurrentFootprintRequest(requestId, context)) return;
    footprintResult.value = failedFootprint(context);
    footprintState.value = "ready";
  }
}

function footprintSizeText(sizeBytes: number | undefined): string {
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return t("common.notMeasured");
  }
  return sizeBytes === 0 ? "0 B" : formatBytes(sizeBytes);
}

function footprintPartText(part: FootprintPart | undefined): string {
  if (footprintState.value === "measuring") return t("drawer.footprintLoading");
  if (!part || part.status === "failed" || part.status === "not-requested") {
    return t("common.notMeasured");
  }
  if (part.status === "missing") return "0 B";
  return footprintSizeText(part.sizeBytes);
}

function footprintSummaryLabel(summary: GameFootprint["summary"]): string {
  if (summary.status === "partial") {
    return `${t("drawer.footprintSummaryLabel")} (${t("drawer.footprintSummaryPartial")})`;
  }
  return t("drawer.footprintSummaryLabel");
}

function footprintSummaryText(): string {
  if (footprintState.value === "measuring") return t("drawer.footprintLoading");
  const summary = footprintResult.value?.summary;
  if (!summary || summary.status === "not-measured") return t("common.notMeasured");
  return footprintSizeText(summary.sizeBytes);
}

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
  return errText(e);
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
  invalidateFootprint();
  invalidateSupportCopy();
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

// Status für das Speichern von Startoptionen.
const launchInput = ref("");
const launchState = ref<"idle" | "saving" | "saved" | string>("idle");
const launchDirty = computed(() => launchInput.value !== (game.value?.launchOptions ?? ""));

watch(
  game,
  (g) => {
    launchInput.value = g?.launchOptions ?? "";
    launchState.value = "idle";
  },
  { immediate: true },
);
watch(launchInput, () => {
  if (launchState.value === "saved") launchState.value = "idle";
});

function launchHintText(hint: LaunchHint): string {
  switch (hint) {
    case "gamemode-missing-command":
      return t("drawer.launchHintGamemodeMissingCommand");
    case "assignment-after-command":
      return t("drawer.launchHintAssignmentAfterCommand");
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

// Auswahl und Status für Compat-Tools.
const compatSelected = ref("__default__");
const compatState = ref<"idle" | "saving" | "saved" | string>("idle");

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

type SupportCopyState = "idle" | "copying" | "copied" | "failed";

interface SupportCopyContext {
  appId: number;
  scanGeneration: number;
}

const supportCopyState = ref<SupportCopyState>("idle");
let supportCopyRequestId = 0;

const supportCopyContext = computed<SupportCopyContext | null>(() => {
  const current = game.value;
  const result = scan.result;
  if (!current || !result || scan.status !== "done") return null;
  return { appId: current.appId, scanGeneration: scan.scanGeneration };
});

function sameSupportCopyContext(
  left: SupportCopyContext | null,
  right: SupportCopyContext | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.appId === right.appId && left.scanGeneration === right.scanGeneration;
}

function invalidateSupportCopy(): void {
  supportCopyRequestId += 1;
  supportCopyState.value = "idle";
}

watch(
  supportCopyContext,
  (current, previous) => {
    if (previous === undefined || !sameSupportCopyContext(current, previous)) {
      invalidateSupportCopy();
    }
  },
  { immediate: true },
);

const canCopySupport = computed(
  () =>
    supportCopyContext.value !== null &&
    launchState.value !== "saving" &&
    compatState.value !== "saving" &&
    supportCopyState.value !== "copying",
);

function isCurrentSupportCopy(requestId: number, context: SupportCopyContext): boolean {
  return (
    requestId === supportCopyRequestId && sameSupportCopyContext(supportCopyContext.value, context)
  );
}

async function copySupport(): Promise<void> {
  const current = game.value;
  const result = scan.result;
  const context = supportCopyContext.value;
  if (!current || !result || !context || !canCopySupport.value) return;

  const snapshot = formatSupportFacts(
    projectSupportFacts({
      game: current,
      result,
      footprint: footprintResult.value,
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
  const requestId = ++supportCopyRequestId;
  supportCopyState.value = "copying";

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    if (isCurrentSupportCopy(requestId, context)) supportCopyState.value = "failed";
    return;
  }

  try {
    await clipboard.writeText(snapshot);
    if (isCurrentSupportCopy(requestId, context)) supportCopyState.value = "copied";
  } catch {
    if (isCurrentSupportCopy(requestId, context)) supportCopyState.value = "failed";
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
          {{ TIER_LABEL[game.protonDb?.tier ?? "unknown"] }}
          <ExplainInfo topic="protondb" :context-key="game.appId" />
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
          <h3 class="section-label">{{ t("drawer.footprintTitle") }}</h3>
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
          <span class="footprint-explain"><ExplainInfo topic="footprint" :context-key="game.appId" /></span>

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
              <ExplainInfo topic="external-compatdata" :context-key="game.appId" />
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
        <p class="section-label mono">{{ t("drawer.configuration") }}</p>

        <div class="field">
          <label class="k" for="compat-tool">
            {{ t("drawer.compatToolLabel") }}
            <ExplainInfo topic="compat-tool" :context-key="game.appId" />
          </label>
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
          <p class="hint" data-testid="compat-provenance">
            {{ compatProvenance }}
            <ExplainInfo topic="compat-source" :context-key="game.appId" />
            <ExplainInfo
              v-if="scan.result?.compatConfigStatus === 'missing' || scan.result?.compatConfigStatus === 'unreadable'"
              topic="config-unavailable"
              :context-key="game.appId"
            />
            <ExplainInfo
              v-if="game.compatToolSource === 'default' && scan.result?.defaultCompatTool"
              topic="global-default"
              :context-key="game.appId"
            />
          </p>
          <p v-if="compatToolUnrecognized" class="hint" data-testid="compat-unrecognized">
            {{ t("drawer.compatToolUnrecognized") }}
            <ExplainInfo topic="tool-unrecognized" :context-key="game.appId" />
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
              :disabled="!launchDirty || launchState === 'saving'"
              @click="saveLaunch"
            >
              {{ launchState === "saving" ? "…" : launchState === "saved" ? t("drawer.saved") : t("drawer.save") }}
            </button>
          </div>
          <p class="hint">{{ t("drawer.launchOptionsHint") }}</p>
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

        <div class="divider" />

        <a class="pdb-link mono" :href="game ? protonDbAppUrl(game.appId) : '#'" @click.prevent="openProtonDb">
          {{ game?.protonDb?.tier === "unknown" ? t("drawer.protondbLookup") : t("drawer.protondbLink") }}
        </a>
        <p class="hint">{{ t("drawer.protondbHint") }}</p>

        <!-- fehler-toast: oben fixiert im drawer, direkt im blick der eingaben -->
        <transition name="toast">
          <div v-if="errorMessage" class="toast" role="alert">
            <span class="toast-icon" aria-hidden="true">⚠</span>
            <span class="toast-msg">{{ errorMessage }}</span>
            <button class="toast-close" type="button" :aria-label="t('app.dismissNotification')" @click="dismissError">✕</button>
          </div>
        </transition>
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
