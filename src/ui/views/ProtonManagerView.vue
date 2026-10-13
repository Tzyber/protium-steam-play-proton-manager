<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { isManagedGeName } from "../../core/geprotonNames";
import type { CompatTool } from "../../core/types";
import ExplainInfo from "../components/ExplainInfo.vue";
import ReleaseRow from "../components/ReleaseRow.vue";
import { relativeTime } from "../dateTime";
import { formatKnownBytes, sizeText } from "../format";
import { t } from "../i18n";
import { formatSizeSummary } from "../sizeSummary";
import { useConfirmStore } from "../stores/confirmStore";
import { useProtonStore } from "../stores/protonStore";
import { useUiStore } from "../stores/uiStore";

const proton = useProtonStore();
const confirm = useConfirmStore();
const ui = useUiStore();

onMounted(() => proton.init());

/** Blockiert eine laufende oder reservierte Aktion das Entfernen? */
const removeBlocked = computed(
  () => proton.busyRemove !== null || confirm.reserved || confirm.busy,
);

function removable(tt: CompatTool): boolean {
  return tt.source === "user" && isManagedGeName(tt.name);
}

// abgleich über den VERZEICHNISNAMEN: r.installName ist der autorisierte
// ordnername in compatibilitytools.d (= tt.name). r.tag bleibt der release-
// und job-schlüssel; internalName aus der tool-vdf kann davon abweichen.
const installedNames = computed(() => new Set(proton.installedTools.map((tt) => tt.name)));

const mappedTools = computed(() => proton.installedTools.filter((tool) => tool.usedBy.length > 0));
const mappedSize = computed(() => formatSizeSummary(mappedTools.value, formatKnownBytes));

const statusFlash = ref(false);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
/** Kurzes aufleuchten der Statuszeile nach dem Refresh: lang genug zum sehen,
 *  kurz genug, um nicht als dauerzustand zu wirken. */
const STATUS_FLASH_MS = 1400;
async function refreshReleases() {
  await proton.loadReleases(true); // expliziter klick → cache umgehen
  statusFlash.value = true;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    statusFlash.value = false;
  }, STATUS_FLASH_MS);
}
// Date.now() ist nicht reaktiv; ohne takt bliebe „gerade eben" stehen.
const now = ref(Date.now());
const nowTimer = setInterval(() => {
  now.value = Date.now();
}, 60_000);
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
  clearInterval(nowTimer);
});

const statusLine = computed(() => {
  if (proton.loading) return null;
  if (proton.lastFetchedAt == null) return null;
  const when = relativeTime(proton.lastFetchedAt, now.value);
  const n = proton.releases.length;
  switch (proton.lastSource) {
    case "fresh":
      return { icon: "✓", text: t("proton.statusUpdated", { n }), ok: true };
    case "not-modified":
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
        <button
          class="rescan"
          type="button"
          :disabled="proton.loading"
          :aria-describedby="proton.loading ? 'proton-rescan-reason' : undefined"
          @click="refreshReleases"
        >
          {{ proton.loading ? t("proton.loading") : t("proton.refreshReleases") }}
        </button>
        <span v-if="proton.loading" id="proton-rescan-reason" class="sr-only">
          {{ t("proton.rescanBlocked") }}
        </span>
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
    <div class="installed-heading">
      <h3 class="section">{{ t("proton.installed") }} <span class="count">{{ proton.installedTools.length }}</span></h3>
      <ExplainInfo :label="t('proton.installed')" :topics="['explicit-mapping-count', 'ge-delete-scope']" />
    </div>
    <p class="rsub" data-testid="mapping-summary">{{ t("proton.mappingSummary", { n: mappedTools.length, size: mappedSize }) }}</p>
    <!-- A-05: der löschfehler gehört zum installiert-abschnitt; vorher lag er in
         `loadError` und erschien damit unter der release-überschrift. -->
    <div v-if="proton.removeError" class="hint" role="alert" data-testid="remove-error">
      {{ proton.removeError }}
    </div>
    <ul class="list" :aria-busy="proton.loading">
      <li v-for="tt in proton.installedTools" :key="tt.name">
        <div class="row">
          <div class="rmain">
            <div class="rname">{{ tt.displayName }}</div>
            <div class="rsub mono">
              {{ tt.internalName }} · {{ sizeText(tt.sizeBytes) }}
              <span v-if="tt.source === 'system'" class="tag distro">{{ t("proton.distroReadonly") }}</span>
            </div>
          </div>
          <button
            v-if="tt.usedBy.length"
            class="used"
            type="button"
            @click="ui.showLibraryForTool(tt.internalName)"
          >
            {{ t("proton.usedBy", { n: tt.usedBy.length }) }}
          </button>
          <span v-else class="used muted">{{ t("proton.unused") }}</span>
          <button
            v-if="removable(tt)"
            class="rm"
            type="button"
            :disabled="removeBlocked"
            :aria-describedby="removeBlocked ? `proton-remove-reason-${tt.name}` : undefined"
            :aria-label="t('proton.deleteToolLabel', { name: tt.name })"
            :aria-busy="proton.busyRemove === tt.name"
            @click="proton.remove(tt)"
          >
            {{ proton.busyRemove === tt.name ? "…" : t("common.delete") }}
          </button>
          <!-- Sperrgrund bzw. Schloss gehören zum selben Zustand: an `removable`,
               nicht aneinander. Sonst zeigt ein nicht entfernbares Tool bei
               globaler Sperre die Begründung ohne Knopf, und bei aufgehobener
               Sperre erscheint das Schloss ohne Aussage. -->
          <span
            v-if="removable(tt) && removeBlocked"
            :id="`proton-remove-reason-${tt.name}`"
            class="sr-only"
          >
            {{ t("proton.removeBlocked") }}
          </span>
          <span v-else-if="!removable(tt)" class="rm-lock" :title="t('proton.notManageable')"
            ><span aria-hidden="true">🔒</span
            ><span class="sr-only">{{ t("proton.notManageable") }}</span></span
          >
        </div>
      </li>
    </ul>

    <!-- verfügbar -->
    <h3 class="section">{{ t("proton.geReleases") }}</h3>
    <div v-if="proton.loadError" class="hint" role="alert" data-testid="releases-error">{{ proton.loadError }}</div>
    <div v-if="proton.warning" class="hint hint--warning" role="status">
      {{ proton.warning.msg }}
      <button type="button" class="hint-close" :aria-label="t('drawer.close')" @click="proton.clearWarning()">×</button>
    </div>
    <ul class="list" :aria-busy="proton.loading">
      <li v-for="r in proton.releases" :key="r.tag">
        <ReleaseRow :release="r" :installed="installedNames.has(r.installName)" />
      </li>
    </ul>

  </section>
</template>

<style scoped>
.pm { padding: 20px 24px; }
.update { position: relative; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
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

.rescan {
  background: var(--bg-2); color: var(--fg-1);
  border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 8px 14px; font-family: var(--font-body); font-size: 0.875rem; cursor: pointer;
}
.rescan:hover:not(:disabled) { color: var(--fg-0); border-color: var(--signal-dim); }

.installed-heading { display: flex; align-items: baseline; gap: 8px; }
.section { font-family: var(--font-display); font-size: 0.875rem; font-weight: 600; margin: 22px 0 10px; color: var(--fg-1); }
.section .count { color: var(--fg-2); font-weight: 400; }

.list { display: grid; gap: 8px; list-style: none; padding: 0; margin: 0; }
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
.tag.distro { color: var(--fg-2); border: 1px solid var(--line); margin-left: 8px; }

.used { background: none; border: 1px solid var(--signal-dim); color: var(--signal-bright); border-radius: var(--r-sm); padding: 5px 9px; font-family: var(--font-body); font-size: 0.875rem; cursor: pointer; white-space: nowrap; }
.used.muted { color: var(--fg-2); border-color: var(--line); cursor: default; }

.rm { background: none; border: 1px solid color-mix(in srgb, var(--tier-borked) 45%, transparent); color: var(--tier-borked); border-radius: var(--r-sm); padding: 5px 10px; font-family: var(--font-body); font-size: 0.875rem; cursor: pointer; }
.rm:hover:not(:disabled) { background: color-mix(in srgb, var(--tier-borked) 14%, transparent); }
.rm-lock { position: relative; color: var(--fg-2); font-size: 0.8125rem; }

.hint { color: var(--tier-gold); font-family: var(--font-body); font-size: 0.75rem; margin-bottom: 10px; }
.hint--warning { color: var(--tier-bronze); display: flex; align-items: center; gap: 8px; } /* bronze statt gold, von fehlermeldung unterscheidbar */
.hint-close {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0;
}
.hint-close:hover { opacity: 0.6; }
</style>
