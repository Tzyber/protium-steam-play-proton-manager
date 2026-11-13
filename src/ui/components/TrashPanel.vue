<script setup lang="ts">
import { computed } from "vue";
import type { TrashEntry } from "../../core/trash";
import type { useSelection } from "../composables/useSelection";
import { shortDate } from "../dateTime";
import { formatKnownBytes, shortPath, sizeText } from "../format";
import { formatError } from "../formatError";
import { t } from "../i18n";
import { bySizeDesc, formatSizeSummary } from "../sizeSummary";
import { useCleanupStore } from "../stores/cleanupStore";
import CleanupRow from "./CleanupRow.vue";
import ExplainInfo from "./ExplainInfo.vue";

// das panel liest nur `selected` und `allSelected`; der rest der
// selection-fassade (toggle/selectAll) gehört der view.
defineProps<{
  selection: Pick<ReturnType<typeof useSelection<TrashEntry>>, "selected" | "allSelected">;
}>();

// FR-4: nur die CleanupView mutiert die auswahl, das panel meldet die absicht.
const emit = defineEmits<{ toggle: [path: string]; "select-all": [] }>();

const cleanup = useCleanupStore();

const trashBySize = computed(() => [...cleanup.trash].sort(bySizeDesc));

const trashTotal = computed(() => formatSizeSummary(cleanup.trash, formatKnownBytes));
</script>

<template>
  <div class="section-bar">
    <span class="section">
      <span class="count" data-testid="trash-total">{{
        t("cleanup.total", { size: trashTotal })
      }}</span>
    </span>
    <div class="section-actions">
      <button
        v-if="trashBySize.length"
        class="sel-all"
        type="button"
        :aria-pressed="selection.allSelected"
        @click="emit('select-all')"
      >
        {{ t("cleanup.selectAll") }}
      </button>
      <button
        class="sel-all"
        type="button"
        :disabled="cleanup.trashScanning"
        @click="cleanup.scanTrash()"
      >
        {{ cleanup.trashScanning ? t("cleanup.searching") : t("cleanup.trashSearchButton") }}
      </button>
    </div>
  </div>

  <div v-if="cleanup.trashLibraries.length" class="libstatus">
    <div v-for="l in cleanup.trashLibraries" :key="l.library" class="mono">
      {{ l.duplicateOf
        ? t("cleanup.trashLibDuplicate", { dir: l.dir || l.library, lib: l.duplicateOf })
        : l.error
          ? t("cleanup.trashLibError", { dir: l.dir || l.library, msg: formatError(l.error) })
          : !l.present
            ? t("cleanup.trashLibNone", { dir: l.dir || l.library })
            : t("cleanup.trashLibCount", { dir: l.dir, n: l.count }) }}
    </div>
  </div>

  <div v-if="cleanup.trashUnknown.length" class="blocked">
    {{ t("cleanup.trashUnknownHint", { n: cleanup.trashUnknown.length }) }}
    <ul class="pm-list">
      <li v-for="p in cleanup.trashUnknown" :key="p" class="mono">{{ p }}</li>
    </ul>
  </div>

  <ul v-if="trashBySize.length" class="list">
    <li v-for="entry in trashBySize" :key="entry.path">
      <CleanupRow
        :label="String(entry.appId)"
        :path="entry.path"
        :short-path="shortPath(entry.path)"
        :size-text="sizeText(entry.sizeBytes)"
        :extra="shortDate(entry.trashedAt)"
        :extra-title="t('cleanup.trashTrashedAt', { date: shortDate(entry.trashedAt) })"
        with-date
        :selected="selection.selected.has(entry.path)"
        @toggle="emit('toggle', entry.path)"
      />
    </li>
  </ul>
  <div v-else-if="cleanup.trashScanning" class="empty">{{ t("cleanup.searching") }}</div>
  <div v-else-if="!cleanup.trashUnavailable" class="empty">
    {{ t("cleanup.trashEmptyState") }}
  </div>
  <div v-else class="empty">
    {{ t("cleanup.unavailable") }}<ExplainInfo
      class="explain-inline"
      :label="t('explain.topics.cleanupBlocked.title')"
      :topics="['cleanup-blocked']"
    />
  </div>
</template>

<style scoped>
.libstatus {
  font-family: var(--font-mono); font-size: var(--text-md); color: var(--fg-1); line-height: var(--leading-mono);
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--r-sm); padding: 12px 16px; margin-bottom: 14px;
  overflow-wrap: anywhere;
}

.pm-list { margin: 0 0 10px; padding-left: 18px; }
.pm-list li { color: var(--fg-1); font-family: var(--font-mono); font-size: var(--text-md); line-height: var(--leading-mono); }

.list { display: grid; gap: 6px; list-style: none; padding: 0; margin: 0; }

.empty { color: var(--fg-2); font-family: var(--font-body); font-size: var(--text-md); padding: 32px 0; text-align: center; }

.section-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; min-height: 34px; }
.section {
  font-family: var(--font-display); font-size: var(--text-lg); font-weight: 600; color: var(--fg-1);
  display: flex; align-items: center; gap: 10px;
}
.section .count { color: var(--fg-2); font-family: var(--font-body); font-weight: 400; }
.section-actions { display: flex; gap: 8px; }

.explain-inline { margin-left: 7px; vertical-align: middle; }
</style>
