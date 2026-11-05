<script setup lang="ts">
import { computed } from "vue";
import { filterAndSortGames } from "../../core/filter";
import FilterBar from "../components/FilterBar.vue";
import GameCard from "../components/GameCard.vue";
import GameDetailDrawer from "../components/GameDetailDrawer.vue";
import ScanCoveragePanel from "../components/ScanCoveragePanel.vue";
import type { Key } from "../i18n";
import { t } from "../i18n";
import { useLibraryStore } from "../stores/libraryStore";
import type { ScanStatus } from "../stores/scanStore";
import { useScanStore } from "../stores/scanStore";

const scan = useScanStore();
const lib = useLibraryStore();

const visible = computed(() =>
  filterAndSortGames(scan.games, {
    search: lib.search,
    sortKey: lib.sortKey,
    sortDir: lib.sortDir,
    tiers: lib.tierSet,
    compatTools: lib.compatToolSet,
    libraries: lib.librarySet,
    compatSource: lib.compatSource ?? undefined,
    protonCheckAppIds: lib.protonCheck ? scan.protonCheckAppIds : undefined,
  }),
);

// t() übersetzt beim rendern, der store hält keinen text. status und phase sind
// exhaustiv auf keys gemappt: ein neuer wert bricht den typecheck.
const STATUS_KEYS: Record<Exclude<ScanStatus, "scanning">, Key> = {
  idle: "status.ready",
  done: "status.ready",
  "not-found": "status.noSteamInstallation",
  error: "status.error",
};

const PHASE_KEYS: Record<"finding-steam" | "scanning-library", Key> = {
  "finding-steam": "status.findingSteam",
  "scanning-library": "status.scanningLibrary",
};

const baseStatusText = computed(() =>
  scan.status === "scanning"
    ? t(scan.scanPhase === "idle" ? "status.findingSteam" : PHASE_KEYS[scan.scanPhase])
    : t(STATUS_KEYS[scan.status]),
);

const visibleStatusText = computed(() =>
  scan.protonDbRemaining > 0
    ? t("library.protonDbRemaining", { n: scan.protonDbRemaining })
    : baseStatusText.value,
);
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
        <span class="status">{{ visibleStatusText }}</span>
        <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ baseStatusText }}</span>
        <button class="rescan" type="button" :disabled="scan.status === 'scanning'" @click="scan.runScan()">
          {{ scan.status === "scanning" ? t("library.scanning") : t("library.rescan") }}
        </button>
      </div>
    </header>

    <ScanCoveragePanel />

    <FilterBar v-if="scan.games.length" />

    <div v-if="scan.status === 'not-found'" class="empty">
      {{ t("library.noSteamFound") }}
    </div>
    <div v-else-if="scan.status === 'error'" class="empty err" role="alert">
      {{ t("library.errorPrefix", { error: scan.error ?? "" }) }}<button class="linklike" type="button" @click="scan.runScan()">{{ t("library.retryScan") }}</button>
    </div>
    <div v-else-if="scan.status === 'scanning' && !scan.games.length" class="empty">{{ t("library.scanningState") }}</div>
    <div v-else-if="!scan.games.length" class="empty">{{ t("library.noGames") }}</div>
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
.title .unit { color: var(--fg-2); font-size: 0.9375rem; font-weight: 400; }

.right { position: relative; display: flex; align-items: center; gap: 12px; }
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

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--gap);
  list-style: none;
  padding: 0;
  margin: 0;
}

.empty {
  padding: 60px 0;
  text-align: center;
  color: var(--fg-2);
  font-family: var(--font-body);
}
.empty.err { color: var(--tier-borked); }
.linklike { background: none; border: none; color: var(--signal-bright); cursor: pointer; font: inherit; text-decoration: underline; }
</style>
