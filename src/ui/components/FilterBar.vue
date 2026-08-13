<script setup lang="ts">
import { computed } from "vue";
import { TIER_ORDER } from "../filter";
import { t } from "../i18n";
import { useLibraryStore } from "../stores/libraryStore";
import { useScanStore } from "../stores/scanStore";

const scan = useScanStore();
const lib = useLibraryStore();

// labels via t(), bei locale-wechsel bleibt die sort-auswahl dieselbe
// (key-basiert), nur das label ändert sich.
const SORTS = computed(() => [
  { key: "name" as const, label: t("filter.sortName") },
  { key: "size" as const, label: t("filter.sortSize") },
  { key: "tier" as const, label: t("filter.sortTier") },
]);

// nur tatsächlich vorkommende werte als filteroptionen anbieten
const tiersPresent = computed(() => {
  const set = new Set(scan.games.map((g) => g.protonDb?.tier ?? "unknown"));
  return TIER_ORDER.filter((t) => set.has(t));
});
const compatToolsPresent = computed(() => [...new Set(scan.games.map((g) => g.compatTool))].sort());
const librariesPresent = computed(() => [...new Set(scan.games.map((g) => g.library))]);

const arrow = computed(() => (lib.sortDir === "asc" ? "↑" : "↓"));

function libShort(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
</script>

<template>
  <div class="filterbar">
    <div class="search">
      <label class="sr-only" for="library-search">{{ t("filter.search") }}</label>
      <span class="ico" aria-hidden="true">⌕</span>
      <input id="library-search" v-model="lib.search" type="text" :placeholder="t('filter.searchPlaceholder')" spellcheck="false" />
      <button v-if="lib.search" class="clear" type="button" :aria-label="t('filter.searchClear')" @click="lib.search = ''">
        <span aria-hidden="true">✕</span>
      </button>
    </div>

    <div class="group">
      <span class="label">{{ t("filter.sort") }}</span>
      <button
        v-for="s in SORTS"
        :key="s.key"
        class="seg"
        :class="{ on: lib.sortKey === s.key }"
        type="button"
        :aria-pressed="lib.sortKey === s.key"
        @click="lib.setSort(s.key)"
      >
        {{ s.label }}<span v-if="lib.sortKey === s.key" class="arr" aria-hidden="true">{{ arrow }}</span><span v-if="lib.sortKey === s.key" class="sr-only">{{ lib.sortDir === "asc" ? t("filter.sortAsc") : t("filter.sortDesc") }}</span>
      </button>
    </div>

    <div class="group">
      <button
        v-for="t in tiersPresent"
        :key="t"
        class="tier-pill"
        :class="[`t-${t}`, { on: lib.tiers.includes(t) }]"
        type="button"
        :aria-pressed="lib.tiers.includes(t)"
        @click="lib.toggle('tiers', t)"
      >
        {{ t }}
      </button>
    </div>

    <div v-if="compatToolsPresent.length > 1" class="group">
      <span class="label">{{ t("filter.proton") }}</span>
      <button
        v-for="c in compatToolsPresent"
        :key="c"
        class="seg small"
        :class="{ on: lib.compatTools.includes(c) }"
        type="button"
        :aria-pressed="lib.compatTools.includes(c)"
        :title="c"
        @click="lib.toggle('compatTools', c)"
      >
        {{ c }}
      </button>
    </div>

    <div v-if="librariesPresent.length > 1" class="group">
      <span class="label">{{ t("filter.disk") }}</span>
      <button
        v-for="l in librariesPresent"
        :key="l"
        class="seg small"
        :class="{ on: lib.libraries.includes(l) }"
        type="button"
        :aria-pressed="lib.libraries.includes(l)"
        :title="l"
        @click="lib.toggle('libraries', l)"
      >
        {{ libShort(l) }}
      </button>
    </div>

    <button v-if="lib.activeFilterCount || lib.search" class="reset" type="button" @click="lib.reset()">
      {{ t("filter.reset") }}
    </button>
  </div>
</template>

<style scoped>
.filterbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 12px 14px;
  margin-bottom: 18px;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: 0 8px;
  flex: 1 1 200px;
  min-width: 160px;
}
.search:focus-within { border-color: var(--signal-dim); }
.search .ico { color: var(--fg-2); font-size: 1rem; }
.search input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--fg-0);
  font-family: var(--font-body);
  font-size: 1rem;
  padding: 8px 0;
}
.search input:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.search .clear { background: none; border: none; color: var(--fg-2); cursor: pointer; font-size: 0.875rem; min-width: 24px; min-height: 24px; display: grid; place-items: center; }

.group { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }

.seg {
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg-1);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  font-family: var(--font-body);
  font-size: 0.8125rem;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.seg.small { font-size: 0.75rem; padding: 5px 8px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg:hover { color: var(--fg-0); border-color: var(--signal-dim); }
.seg.on {
  color: var(--signal-bright);
  border-color: var(--signal);
  background: color-mix(in srgb, var(--signal) 14%, transparent);
}
.arr { margin-left: 5px; opacity: 0.8; }

.tier-pill {
  --c: var(--tier-unknown);
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
  color: color-mix(in srgb, var(--c) 75%, var(--fg-1));
  border-radius: 999px;
  padding: 5px 10px;
  font-family: var(--font-body);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
}
.tier-pill.on { background: color-mix(in srgb, var(--c) 20%, transparent); color: var(--c); border-color: var(--c); }
.t-platinum { --c: var(--tier-platinum); }
.t-gold { --c: var(--tier-gold); }
.t-silver { --c: var(--tier-silver); }
.t-bronze { --c: var(--tier-bronze); }
.t-borked { --c: var(--tier-borked); }
.t-unknown { --c: var(--tier-unknown); }

/* filter-gruppen-labels (SORT / PROTON / DISK) werden gelesen, nicht gescannt 
   vom globalen .label (mono) auf body umstellen. gleiche schrift wie die chips
   daneben, damit das gruppen-label nicht aus dem raster fällt. */
.label { font-family: var(--font-body); }

.reset {
  margin-left: auto;
  background: none;
  border: 1px solid var(--line);
  color: var(--fg-2);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  font-family: var(--font-body);
  font-size: 0.75rem;
  cursor: pointer;
}
.reset:hover { color: var(--fg-0); border-color: var(--signal-dim); }
</style>
