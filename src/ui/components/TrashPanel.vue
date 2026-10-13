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

defineProps<{ selection: ReturnType<typeof useSelection<TrashEntry>> }>();

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
        @click="selection.selectAll()"
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
        @toggle="selection.toggle(entry.path)"
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
  font-family: var(--font-mono); font-size: 0.875rem; color: var(--fg-1); line-height: 1.7;
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--r-sm); padding: 12px 16px; margin-bottom: 14px;
  overflow-wrap: anywhere;
}

.blocked {
  background: color-mix(in srgb, var(--tier-borked) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--tier-borked) 40%, transparent);
  color: #ff9aa0;
  border-radius: var(--r-sm);
  padding: 12px 16px;
  font-family: var(--font-body);
  font-size: 0.875rem;
  margin-bottom: 16px;
}

.pm-list { margin: 0 0 10px; padding-left: 18px; }
.pm-list li { color: var(--fg-1); font-family: var(--font-mono); font-size: 0.875rem; line-height: 1.6; }

.list { display: grid; gap: 6px; list-style: none; padding: 0; margin: 0; }

.empty { color: var(--fg-2); font-family: var(--font-body); font-size: 0.875rem; padding: 32px 0; text-align: center; }

.section-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; min-height: 34px; }
.section {
  font-family: var(--font-display); font-size: 1rem; font-weight: 600; color: var(--fg-1);
  display: flex; align-items: center; gap: 10px;
}
.section .count { color: var(--fg-2); font-weight: 400; }
.section-actions { display: flex; gap: 8px; }

.sel-all {
  background: none; border: 1px solid var(--line); color: var(--fg-1);
  border-radius: var(--r-sm); padding: 8px 14px;
  font-family: var(--font-body); font-size: 0.875rem; cursor: pointer;
}
.sel-all:hover:not(:disabled) { color: var(--fg-0); border-color: var(--signal-dim); }
.sel-all:disabled { opacity: 0.55; cursor: default; }
.sel-all:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }

.explain-inline { margin-left: 7px; vertical-align: middle; }
</style>
