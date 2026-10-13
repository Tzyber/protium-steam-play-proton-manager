<script setup lang="ts">
import type { GeRelease } from "../../core/geprotonReleases";
import { formatBytes } from "../format";
import type { Key } from "../i18n";
import { t } from "../i18n";
import type { Phase } from "../stores/protonStore";
import { useProtonStore } from "../stores/protonStore";

const props = defineProps<{ release: GeRelease; installed: boolean }>();

const proton = useProtonStore();

function pct(tag: string): number | null {
  const j = proton.jobs[tag];
  if (!j?.total) return null;
  return Math.min(100, Math.round((j.downloaded / j.total) * 100));
}

/** Ohne bekannte Gesamtgröße gibt es keinen echten Prozentwert: dann läuft der
 *  Balken als indeterminierte Animation (U-06), statt einen erfundenen
 *  Füllstand vorzutäuschen. */
function fillStyle(tag: string): Record<string, string> | undefined {
  const value = pct(tag);
  return value === null ? undefined : { transform: `scaleX(${value / 100})` };
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
</script>

<template>
  <div class="row">
          <div class="rmain">
            <div class="rname">
              {{ props.release.tag }}
              <span v-if="props.installed" class="tag ok">{{ t("proton.installed") }}</span>
            </div>
            <div class="rsub mono">{{ formatBytes(props.release.tarball.size) }}</div>
            <div v-if="proton.jobs[props.release.tag]" class="progress" role="progressbar" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="pct(props.release.tag) ?? undefined" :aria-label="phaseLabel(props.release.tag)">
              <template v-if="proton.jobs[props.release.tag]?.phase === 'downloading'">
                <div class="track"><div class="fill" :class="{ 'fill--indeterminate': pct(props.release.tag) === null }" :style="fillStyle(props.release.tag)" /></div>
                <span class="phase"><span aria-live="polite">{{ phaseLabel(props.release.tag) }}</span><span v-if="pct(props.release.tag) !== null"> · {{ pct(props.release.tag) }}%</span><span v-if="speedLabel(props.release.tag)"> · {{ speedLabel(props.release.tag) }}</span></span>
              </template>
              <span v-else class="phase act" aria-live="polite">{{ phaseLabel(props.release.tag) }}<span v-if="proton.jobs[props.release.tag]?.phase === 'extracting' && proton.jobs[props.release.tag]?.verified"> ✓ {{ t("proton.checksumOk") }}</span></span>
            </div>
          </div>
          <button
            v-if="!props.installed && !proton.jobs[props.release.tag]"
            class="install"
            type="button"
            @click="proton.queueInstall(props.release)"
          >
            {{ t("proton.install") }}
          </button>
          <button
            v-else-if="proton.jobs[props.release.tag]"
            class="cancel"
            type="button"
            :title="proton.activeTag === props.release.tag ? t('proton.cancelDownload') : t('proton.cancelQueue')"
            @click="proton.cancel(props.release.tag)"
          >
            <span aria-hidden="true">✕</span> {{ t("common.cancel") }}
          </button>
          <span v-else class="used muted">{{ t("proton.installed") }}</span>
        </div>
</template>

<style scoped>
.row {
  position: relative;
  display: flex; align-items: center; gap: 14px;
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--r-md); padding: 12px 14px;
}
.rmain { flex: 1; min-width: 0; }
.rname { font-family: var(--font-display); font-weight: 600; font-size: 0.875rem; display: flex; align-items: center; gap: 8px; }
.rsub { color: var(--fg-2); font-size: 0.8125rem; font-weight: 600; margin-top: 3px; }

.tag { font-family: var(--font-body); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 6px; border-radius: 999px; }
.tag.ok { color: var(--tier-platinum); background: color-mix(in srgb, var(--tier-platinum) 14%, transparent); }

.used { background: none; border: 1px solid var(--signal-dim); color: var(--signal-bright); border-radius: var(--r-sm); padding: 5px 9px; font-family: var(--font-body); font-size: 0.875rem; cursor: pointer; white-space: nowrap; }
.used.muted { color: var(--fg-2); border-color: var(--line); cursor: default; }

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
/* unbekannte gesamtgröße: ein durchlaufender Balken statt eines erfundenen
   Prozentwerts (aria-valuenow fehlt, also indeterminierte progressbar). */
.fill--indeterminate { width: 40%; transform: none; animation: fill-indeterminate 1.2s ease-in-out infinite; }
@keyframes fill-indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}
@media (prefers-reduced-motion: reduce) {
  .fill--indeterminate { width: 100%; opacity: 0.4; animation: none; }
}
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
</style>
