<script setup lang="ts">
import { computed } from "vue";
import type { OrphanEntry } from "../../core/types";
import type { useSelection } from "../composables/useSelection";
import { formatKnownBytes, shortPath, sizeText } from "../format";
import { t } from "../i18n";
import { formatSizeSummary } from "../sizeSummary";
import { useCleanupStore } from "../stores/cleanupStore";
import CleanupRow from "./CleanupRow.vue";
import ExplainInfo from "./ExplainInfo.vue";

const props = defineProps<{
  kind: "shader" | "prefix";
  entries: OrphanEntry[];
  // das panel liest nur `selected` und `allSelected`; der rest der
  // selection-fassade (toggle/selectAll) gehört der view.
  selection: Pick<ReturnType<typeof useSelection<OrphanEntry>>, "selected" | "allSelected">;
}>();

// FR-4: das panel liest die auswahl nur. mutiert wird ausschließlich in der
// CleanupView, sonst schreibt jedes panel in denselben fremden state.
const emit = defineEmits<{ toggle: [path: string]; "select-all": [] }>();

const cleanup = useCleanupStore();

const total = computed(() => formatSizeSummary(props.entries, formatKnownBytes));
const steamOwnedTotal = computed(() =>
  formatSizeSummary(cleanup.steamOwnedPrefixes, formatKnownBytes),
);
const unavailable = computed(() =>
  props.kind === "shader" ? cleanup.shaderUnavailable : cleanup.prefixUnavailable,
);

/** spielname aus steams localconfig, sonst die app-id (z. B. bei
 *  non-steam-shortcuts oder fehlendem eintrag). */
function orphanLabel(o: OrphanEntry): string {
  return cleanup.orphanNames[o.path] ?? String(o.appId);
}
</script>

<template>
  <div class="section-bar">
    <span class="section">
      <span v-if="kind === 'prefix'" class="warn-label">{{ t("cleanup.winePrefixWarn") }}</span>
      <span class="count" :data-testid="kind === 'shader' ? 'shader-total' : 'prefix-total'">{{
        t("cleanup.total", { size: total })
      }}</span>
    </span>
    <button
      v-if="entries.length"
      class="sel-all"
      :class="{ warn: kind === 'prefix' }"
      type="button"
      :aria-pressed="selection.allSelected"
      @click="emit('select-all')"
    >
      {{ t("cleanup.selectAll") }}
    </button>
  </div>

  <p v-if="kind === 'prefix'" class="moved-note">{{ t("cleanup.winePrefixMovedNote") }}</p>

  <div
    v-if="kind === 'prefix' && cleanup.steamOwnedPrefixes.length"
    class="blocked"
    role="status"
    data-testid="steam-owned-total"
  >
    {{
      t("cleanup.steamOwnedHint", {
        n: cleanup.steamOwnedPrefixes.length,
        size: steamOwnedTotal,
      })
    }}
    <ExplainInfo
      class="explain-inline"
      :label="t('explain.topics.steamOwned.title')"
      :topics="['steam-owned']"
    />
  </div>

  <ul v-if="entries.length" class="list">
    <li v-for="o in entries" :key="o.path">
      <CleanupRow
        :label="orphanLabel(o)"
        :path="o.path"
        :short-path="shortPath(o.path)"
        :size-text="sizeText(o.sizeBytes)"
        :selected="selection.selected.has(o.path)"
        :warning="
          kind === 'prefix' && o.potentialShortcut ? t('cleanup.potentialShortcutTooltip') : undefined
        "
        @toggle="emit('toggle', o.path)"
      />
    </li>
  </ul>
  <div v-else-if="cleanup.scanning" class="empty">{{ t("cleanup.searching") }}</div>
  <div v-else-if="!unavailable" class="empty">{{ t("cleanup.empty") }}</div>
  <div v-else class="empty">
    {{ t("cleanup.unavailable") }}<ExplainInfo
      class="explain-inline"
      :label="t('explain.topics.cleanupBlocked.title')"
      :topics="['cleanup-blocked']"
    />
  </div>
</template>

<style scoped>
.section-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; min-height: 34px; }
.section {
  font-family: var(--font-display); font-size: var(--text-lg); font-weight: 600; color: var(--fg-1);
  display: flex; align-items: center; gap: 10px;
}
.section .count { color: var(--fg-2); font-family: var(--font-body); font-weight: 400; }
.section .warn-label {
  font-family: var(--font-body); font-size: var(--text-md); color: var(--fg-1);
  border: 1px solid var(--warning-border);
  border-radius: 999px; padding: 2px 9px;
}

.sel-all.warn:hover:not(:disabled) { border-color: var(--warning-text); color: var(--warning-text); }

.moved-note {
  color: var(--fg-2); font-size: var(--text-md); font-family: var(--font-body);
  margin: 0 0 10px;
}

.list { display: grid; gap: 6px; list-style: none; padding: 0; margin: 0; }

.empty { color: var(--fg-2); font-family: var(--font-body); font-size: var(--text-md); padding: 32px 0; text-align: center; }
.explain-inline { margin-left: 7px; vertical-align: middle; }
</style>
