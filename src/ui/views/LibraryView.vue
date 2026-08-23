<script setup lang="ts">
import { computed, ref } from "vue";
import FilterBar from "../components/FilterBar.vue";
import GameCard from "../components/GameCard.vue";
import GameDetailDrawer from "../components/GameDetailDrawer.vue";
import { filterAndSortGames } from "../filter";
import { t } from "../i18n";
import { useLibraryStore } from "../stores/libraryStore";
import { useScanStore } from "../stores/scanStore";

const scan = useScanStore();
const lib = useLibraryStore();
const warningsId = "library-warnings";

const visible = computed(() =>
  filterAndSortGames(scan.games, {
    search: lib.search,
    sortKey: lib.sortKey,
    sortDir: lib.sortDir,
    tiers: lib.tierSet,
    compatTools: lib.compatToolSet,
    libraries: lib.librarySet,
    protonCheckAppIds: lib.protonCheck ? scan.protonCheckAppIds : undefined,
  }),
);

const statusText = computed(() =>
  scan.protonDbRemaining > 0
    ? t("library.protonDbRemaining", { n: scan.protonDbRemaining })
    : scan.statusText,
);

const showWarnings = ref(false);
</script>

<template>
  <section class="library">
    <header class="bar">
      <div class="title">
        <span class="label">{{ t("library.label") }}</span>
        <h1>
          {{ visible.length }}
          <span class="unit">{{ t("library.gamesCount", { n: scan.games.length }) }}</span>
        </h1>
      </div>

      <div class="right">
        <button
          v-if="scan.warnings.length"
          class="warn-toggle"
          type="button"
          :aria-label="t('library.warningsToggle', { n: scan.warnings.length })"
          :aria-expanded="showWarnings"
          :aria-controls="warningsId"
          @click="showWarnings = !showWarnings"
        >
          <span aria-hidden="true">⚠</span> {{ scan.warnings.length }}
        </button>
        <span class="status" role="status" aria-live="polite" aria-atomic="true">{{ statusText }}</span>
        <button class="rescan" type="button" :disabled="scan.status === 'scanning'" @click="scan.runScan()">
          {{ scan.status === "scanning" ? t("library.scanning") : t("library.rescan") }}
        </button>
      </div>
    </header>

    <transition name="fade">
      <ul
        v-if="showWarnings && scan.warnings.length"
        :id="warningsId"
        class="warnings"
        aria-live="polite"
        aria-atomic="true"
      >
        <li v-for="(w, i) in scan.warnings" :key="i">{{ w }}</li>
      </ul>
    </transition>

    <FilterBar v-if="scan.games.length" />

    <div v-if="scan.status === 'not-found'" class="empty">
      {{ t("library.noSteamFound") }}
    </div>
    <div v-else-if="scan.status === 'error'" class="empty err" role="alert">{{ t("library.errorPrefix", { error: scan.error ?? "" }) }}</div>
    <div v-else-if="scan.status === 'scanning' && !scan.games.length" class="empty">{{ t("library.scanningState") }}</div>
    <div v-else-if="!visible.length" class="empty">
      {{ t("library.nothingFound") }}<button class="linklike" type="button" @click="lib.reset()">{{ t("library.resetFilter") }}</button>
    </div>

    <ul v-else class="grid">
      <li v-for="g in visible" :key="g.appId" class="grid-item">
        <GameCard :game="g" />
      </li>
    </ul>

    <GameDetailDrawer />
  </section>
</template>

<style scoped>
.library { padding: 20px 24px; scrollbar-gutter: stable; }

.bar {
  gap: 16px;
}
.title h1 {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 1.625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.title .unit { color: var(--fg-2); font-size: 0.9375rem; font-weight: 400; }

.right { display: flex; align-items: center; gap: 12px; }
.status { color: var(--fg-2); font-size: 0.875rem; }

.rescan {
  background: var(--signal);
  color: #0a0b11;
  border: none;
  border-radius: var(--r-sm);
  padding: 8px 14px;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 1rem;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
}
.rescan:hover:not(:disabled) { background: var(--signal-bright); box-shadow: 0 0 20px -4px var(--signal-glow); }
.rescan:disabled { opacity: 0.5; cursor: default; }

.warn-toggle {
  background: color-mix(in srgb, var(--tier-gold) 12%, transparent);
  color: var(--tier-gold);
  border: 1px solid color-mix(in srgb, var(--tier-gold) 40%, transparent);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  font-family: var(--font-body);
  font-size: 0.8125rem;
  cursor: pointer;
}

.warnings {
  margin: 0 0 18px;
  padding: 12px 14px;
  list-style: none;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  font-family: var(--font-body);
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--fg-1);
  display: grid;
  gap: 6px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--gap);
  list-style: none;
  padding: 0;
  margin: 0;
}
.grid-item { display: contents; }

.empty {
  padding: 60px 0;
  text-align: center;
  color: var(--fg-2);
  font-family: var(--font-body);
}
.empty.err { color: var(--tier-borked); }
.linklike { background: none; border: none; color: var(--signal-bright); cursor: pointer; font: inherit; text-decoration: underline; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
