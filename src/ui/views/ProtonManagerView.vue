<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CompatTool } from "../../core/types";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { formatBytes } from "../format";
import type { Key } from "../i18n";
import { t } from "../i18n";
import type { Phase } from "../stores/protonStore";
import { useProtonStore } from "../stores/protonStore";
import { useScanStore } from "../stores/scanStore";
import { useUiStore } from "../stores/uiStore";

const proton = useProtonStore();
const scan = useScanStore();
const ui = useUiStore();

onMounted(() => proton.init());

// appId → name, um usedBy in klarnamen aufzulösen
const nameOf = computed(() => new Map(scan.games.map((g) => [g.appId, g.name])));

function removable(tt: CompatTool): boolean {
  return tt.source === "user" && /^GE-Proton/i.test(tt.name);
}

// abgleich über den VERZEICHNISNAMEN: r.tag ist der GE-release-tag und wird als
// ordnername in compatibilitytools.d installiert (= tt.name). internalName aus
// der tool-vdf kann davon abweichen.
const installedNames = computed(() => new Set(proton.installedTools.map((tt) => tt.name)));

// remove-confirm-state
const toRemove = ref<CompatTool | null>(null);

// hauptinhalt stilllegen während confirm-dialog offen ist
watch(toRemove, (v) => {
  ui.inertMain = !!v;
});
const removeGames = computed(() =>
  toRemove.value
    ? toRemove.value.usedBy.map((id) => nameOf.value.get(id) ?? t("proton.appId", { id }))
    : [],
);
function confirmRemove() {
  if (toRemove.value) proton.remove(toRemove.value);
  toRemove.value = null;
}

function pct(tag: string): number | null {
  const j = proton.jobs[tag];
  if (!j?.total) return null;
  return Math.min(100, Math.round((j.downloaded / j.total) * 100));
}

// literale keys statt laufzeit-konkatenation: fehlt eine übersetzung, schlägt
// der typecheck fehl statt erst die UI.
const PHASE_KEYS = {
  queued: "phase.queued",
  downloading: "phase.downloading",
  verifying: "phase.verifying",
  extracting: "phase.extracting",
} as const satisfies Record<Phase, Key>;

function phaseLabel(tag: string): string {
  const phase = proton.jobs[tag]?.phase;
  return phase ? t(PHASE_KEYS[phase]) : "";
}

function speedLabel(tag: string): string {
  const speed = proton.jobs[tag]?.speed ?? 0;
  return speed > 0 ? `${formatBytes(Math.round(speed))}/s` : "";
}

function relTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t("time.justNow");
  const m = Math.round(s / 60);
  if (m < 60) return t("time.minutesAgo", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("time.hoursAgo", { n: h });
  return t("time.daysAgo", { n: Math.round(h / 24) });
}

const statusFlash = ref(false);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
async function refreshReleases() {
  await proton.loadReleases(true); // expliziter klick → cache umgehen
  statusFlash.value = true;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    statusFlash.value = false;
  }, 1400);
}
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
  ui.inertMain = false;
});

const statusLine = computed(() => {
  if (proton.loading) return null;
  if (proton.lastFetchedAt == null) return null;
  const when = relTime(proton.lastFetchedAt);
  const n = proton.releases.length;
  switch (proton.lastSource) {
    case "fresh":
      return { icon: "✓", text: t("proton.statusUpdated", { n }), ok: true };
    case "not-modified":
      return { icon: "✓", text: t("proton.statusCurrent", { when }), ok: true };
    case "cache":
      return { icon: "✓", text: t("proton.statusCurrent", { when }), ok: true };
    case "offline":
      return { icon: "⚠", text: t("proton.statusOffline", { when }), ok: false };
    default:
      return null;
  }
});
</script>

<template>
  <section class="pm">
    <header class="bar">
      <div class="title">
        <span class="label">{{ t("filter.proton") }}</span>
        <h1>{{ t("proton.versions") }}</h1>
      </div>
      <div class="update">
        <button class="rescan" type="button" :disabled="proton.loading" @click="refreshReleases">
          {{ proton.loading ? t("proton.loading") : t("proton.refreshReleases") }}
        </button>
        <div
          v-if="statusLine"
          class="statusline"
          role="status"
          :class="{ warn: !statusLine.ok, flash: statusFlash }"
        >
          <span class="ic" aria-hidden="true">{{ statusLine.icon }}</span> {{ statusLine.text }}
        </div>
      </div>
    </header>

    <!-- installiert -->
    <h3 class="section">{{ t("proton.installed") }} <span class="count">{{ proton.installedTools.length }}</span></h3>
    <ul class="list" :aria-busy="proton.loading">
      <li v-for="tt in proton.installedTools" :key="tt.name">
        <div class="row">
          <div class="rmain">
            <div class="rname">{{ tt.displayName }}</div>
            <div class="rsub mono">
              {{ tt.internalName }} · {{ formatBytes(tt.sizeBytes) }}
              <span v-if="tt.source === 'system'" class="tag distro">{{ t("proton.distroReadonly") }}</span>
            </div>
          </div>
          <button v-if="tt.usedBy.length" class="used" type="button" @click="ui.showLibraryForTool(tt.internalName)">
            {{ t("proton.usedBy", { n: tt.usedBy.length }) }}
          </button>
          <span v-else class="used muted">{{ t("proton.unused") }}</span>
          <button
            v-if="removable(tt)"
            class="rm"
            type="button"
            :disabled="proton.busyRemove === tt.name"
            @click="toRemove = tt"
          >
            {{ proton.busyRemove === tt.name ? "…" : t("common.delete") }}
          </button>
          <span v-else class="rm-lock" :title="t('proton.notManageable')"><span aria-hidden="true">🔒</span><span class="sr-only">{{ t('proton.notManageable') }}</span></span>
        </div>
      </li>
    </ul>

    <!-- verfügbar -->
    <h3 class="section">{{ t("proton.geReleases") }}</h3>
    <div v-if="proton.loadError" class="hint" role="alert">{{ proton.loadError }}</div>
    <div v-if="proton.warning" class="hint hint--warning" role="status">
      {{ proton.warning.msg }}
      <button type="button" class="hint-close" :aria-label="t('drawer.close')" @click="proton.clearWarning()">×</button>
    </div>
    <ul class="list" :aria-busy="proton.loading">
      <li v-for="r in proton.releases" :key="r.tag">
        <div class="row">
          <div class="rmain">
            <div class="rname">
              {{ r.tag }}
              <span v-if="installedNames.has(r.tag)" class="tag ok">{{ t("proton.installed") }}</span>
            </div>
            <div class="rsub mono">{{ formatBytes(r.tarball.size) }}</div>
            <div v-if="proton.jobs[r.tag]" class="progress" role="progressbar" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="pct(r.tag) ?? undefined" :aria-label="phaseLabel(r.tag)">
              <template v-if="proton.jobs[r.tag]?.phase === 'downloading'">
                <div class="track"><div class="fill" :style="{ transform: `scaleX(${(pct(r.tag) ?? 30) / 100})` }" /></div>
                <span class="phase" aria-live="polite">{{ phaseLabel(r.tag) }}<span v-if="pct(r.tag) !== null"> · {{ pct(r.tag) }}%</span><span v-if="speedLabel(r.tag)"> · {{ speedLabel(r.tag) }}</span></span>
              </template>
              <span v-else class="phase act" aria-live="polite">{{ phaseLabel(r.tag) }}<span v-if="proton.jobs[r.tag]?.phase === 'extracting' && proton.jobs[r.tag]?.verified"> ✓ {{ t("proton.checksumOk") }}</span></span>
            </div>
          </div>
          <button
            v-if="!installedNames.has(r.tag) && !proton.jobs[r.tag]"
            class="install"
            type="button"
            @click="proton.queueInstall(r)"
          >
            {{ t("proton.install") }}
          </button>
          <button
            v-else-if="proton.jobs[r.tag]"
            class="cancel"
            type="button"
            :title="proton.activeTag === r.tag ? t('proton.cancelDownload') : t('proton.cancelQueue')"
            @click="proton.cancel(r.tag)"
          >
            <span aria-hidden="true">✕</span> {{ t("common.cancel") }}
          </button>
          <span v-else class="used muted" aria-label="✓">{{ t("proton.installed") }}</span>
        </div>
      </li>
    </ul>

    <ConfirmDialog
      v-if="toRemove"
      :title="t('proton.deleteTitle', { name: toRemove.displayName })"
      :confirm-label="t('common.delete')"
      danger
      @cancel="toRemove = null"
      @confirm="confirmRemove"
    >
      <template v-if="removeGames.length">
        <p>{{ t("proton.usedByConfirm", { n: removeGames.length }) }}</p>
        <ul class="games">
          <li v-for="g in removeGames" :key="g">{{ g }}</li>
        </ul>
      </template>
      <p v-else>{{ t("proton.unusedConfirm") }}</p>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.pm { padding: 20px 24px; }
.update { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.statusline {
  font-family: var(--font-body);
  font-size: 0.8125rem;
  color: var(--fg-1);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  transition: background 0.3s, border-color 0.3s, color 0.3s;
}
.statusline .ic { color: var(--tier-platinum); font-size: 1rem; }
.statusline.warn { color: var(--tier-gold); }
.statusline.warn .ic { color: var(--tier-gold); }
.statusline.flash {
  color: var(--signal-bright);
  border-color: var(--signal);
  background: color-mix(in srgb, var(--signal) 16%, transparent);
}
.title h1 { margin: 2px 0 0; font-family: var(--font-display); font-size: 1.625rem; font-weight: 600; letter-spacing: -0.02em; }

.rescan {
  background: var(--bg-2); color: var(--fg-1);
  border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 8px 14px; font-family: var(--font-body); font-size: 0.875rem; cursor: pointer;
}
.rescan:hover:not(:disabled) { color: var(--fg-0); border-color: var(--signal-dim); }

.section { font-family: var(--font-display); font-size: 0.875rem; font-weight: 600; margin: 22px 0 10px; color: var(--fg-1); }
.section .count { color: var(--fg-2); font-weight: 400; }

.list { display: grid; gap: 8px; list-style: none; padding: 0; margin: 0; }
.list > li { display: contents; }
.row {
  display: flex; align-items: center; gap: 14px;
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--r-md); padding: 12px 14px;
}
.rmain { flex: 1; min-width: 0; }
.rname { font-family: var(--font-display); font-weight: 600; font-size: 0.875rem; display: flex; align-items: center; gap: 8px; }
.rsub { color: var(--fg-2); font-size: 0.8125rem; font-weight: 600; margin-top: 3px; }

.tag { font-family: var(--font-body); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 6px; border-radius: 999px; }
.tag.ok { color: var(--tier-platinum); background: color-mix(in srgb, var(--tier-platinum) 14%, transparent); }
.tag.distro { color: var(--fg-2); border: 1px solid var(--line); margin-left: 8px; }

.used { background: none; border: 1px solid var(--signal-dim); color: var(--signal-bright); border-radius: var(--r-sm); padding: 5px 9px; font-family: var(--font-body); font-size: 0.875rem; cursor: pointer; white-space: nowrap; }
.used.muted { color: var(--fg-2); border-color: var(--line); cursor: default; }

.rm { background: none; border: 1px solid color-mix(in srgb, var(--tier-borked) 45%, transparent); color: var(--tier-borked); border-radius: var(--r-sm); padding: 5px 10px; font-family: var(--font-body); font-size: 0.875rem; cursor: pointer; }
.rm:hover:not(:disabled) { background: color-mix(in srgb, var(--tier-borked) 14%, transparent); }
.rm-lock { color: var(--fg-2); font-size: 0.8125rem; }

.install { background: var(--signal); color: #0a0b11; border: none; border-radius: var(--r-sm); padding: 7px 14px; font-family: var(--font-body); font-weight: 600; font-size: 0.8125rem; cursor: pointer; }
.install:hover:not(:disabled) { background: var(--signal-bright); }
.cancel {
  background: none;
  border: 1px solid color-mix(in srgb, var(--tier-borked) 50%, transparent);
  color: var(--tier-borked);
  border-radius: var(--r-sm);
  padding: 7px 12px;
  font-family: var(--font-body);
  font-size: 0.8125rem;
  cursor: pointer;
  white-space: nowrap;
}
.cancel:hover { background: color-mix(in srgb, var(--tier-borked) 14%, transparent); }

.progress { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.track { flex: 1; max-width: 320px; height: 5px; background: var(--bg-0); border-radius: 999px; overflow: hidden; }
.fill { width: 100%; height: 100%; background: var(--signal); transform-origin: left; transition: transform 0.2s; }
.phase { color: var(--fg-2); font-size: 0.75rem; }
.phase.act::before {
  content: "●";
  display: inline-block;
  font-size: 0.9rem;
  line-height: 1;
  vertical-align: middle;
  margin-right: 0.35em;
  animation: phase-pulse 1s ease-in-out infinite;
}
.phase.act { color: var(--signal-bright); }
@keyframes phase-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .phase.act::before { opacity: 0.6; animation: none; }
}

.hint { color: var(--tier-gold); font-family: var(--font-body); font-size: 0.75rem; margin-bottom: 10px; }
.hint--warning { color: var(--tier-bronze); display: flex; align-items: center; gap: 8px; } /* bronze statt gold, von fehlermeldung unterscheidbar */
.hint-close { background: none; border: none; color: inherit; cursor: pointer; font-size: 1rem; line-height: 1; padding: 2px 4px; }
.hint-close:hover { opacity: 0.6; }
.games { margin: 8px 0 0; padding-left: 18px; color: var(--fg-1); }
.games li { margin: 2px 0; }
</style>
