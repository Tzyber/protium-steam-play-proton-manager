<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import CleanupNotices from "../components/CleanupNotices.vue";
import OrphanPanel from "../components/OrphanPanel.vue";
import TrashPanel from "../components/TrashPanel.vue";
import { useSelection } from "../composables/useSelection";
import { logError } from "../diagnostics";
import { formatKnownBytes } from "../format";
import { t } from "../i18n";
import { bySizeDesc, formatSizeSummary } from "../sizeSummary";
import { useCleanupStore } from "../stores/cleanupStore";
import { useConfirmStore } from "../stores/confirmStore";
import { useScanStore } from "../stores/scanStore";

const cleanup = useCleanupStore();
const confirm = useConfirmStore();
const scan = useScanStore();

// ---- tabs ----
// pro tab genau eine liste und genau eine leiste, die sich auf DIESE liste bezieht.
type Tab = "shaders" | "prefixes" | "trash";
const TABS: Tab[] = ["shaders", "prefixes", "trash"];
const tab = ref<Tab>("shaders");
const tabEls = ref<(HTMLButtonElement | null)[]>([]);

function setTabRef(el: unknown, i: number) {
  tabEls.value[i] = el instanceof HTMLButtonElement ? el : null;
}

/** pfeiltasten-navigation nach WAI-ARIA tabs-pattern */
function onTabKeydown(e: KeyboardEvent, i: number) {
  let next: number;
  if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
  else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = TABS.length - 1;
  else return;
  e.preventDefault();
  const target = TABS[next];
  if (!target) return;
  tab.value = target;
  nextTick(() => tabEls.value[next]?.focus());
}

/** quelle des aktuell angezeigten cleanup-snapshots. ein neuer library-scan
 *  verwirft den alten stand sofort und lädt nach seinem erfolgreichen ende
 *  genau einmal nach. */
let cleanupScanGeneration: number | null = null;

async function refreshCleanupForScan(generation: number) {
  await cleanup.scanOrphans();
  if (scan.status !== "done" || scan.scanGeneration !== generation || scan.result === null) return;
  await cleanup.scanTrash();
}

function resetCleanupForLibraryScan() {
  selected.clear();
  trashSelection.selected.clear();
  cleanup.resetForLibraryScan();
}

onMounted(async () => {
  if (scan.status !== "done" || scan.result === null) {
    if (scan.status !== "idle") resetCleanupForLibraryScan();
    return;
  }

  cleanupScanGeneration = scan.scanGeneration;
  await refreshCleanupForScan(cleanupScanGeneration);
  // nicht auf einem leeren tab landen
  if (!shadercacheOrphans.value.length) {
    if (compatdataOrphans.value.length) tab.value = "prefixes";
    else if (cleanup.trash.length) tab.value = "trash";
  }
});

watch(
  () => [scan.status, scan.scanGeneration, scan.result] as const,
  async ([status, generation, result]) => {
    if (status === "scanning") {
      cleanupScanGeneration = null;
      resetCleanupForLibraryScan();
      return;
    }
    if (status !== "done" || result === null || cleanupScanGeneration === generation) return;
    cleanupScanGeneration = generation;
    await refreshCleanupForScan(generation);
  },
);

// ---- verwaiste daten ----

const shadercacheOrphans = computed(() => [...cleanup.shadercacheOrphans].sort(bySizeDesc));
const compatdataOrphans = computed(() => [...cleanup.compatdataOrphans].sort(bySizeDesc));

const selected = reactive(new Set<string>());
const shaders = useSelection(() => shadercacheOrphans.value, { selected });
const prefixes = useSelection(() => compatdataOrphans.value, {
  selected,
  candidates: (entries) => entries.filter((entry) => !entry.potentialShortcut),
});
const trashSelection = useSelection(() => cleanup.trash);

function displaySize(entries: readonly { sizeBytes?: number }[]): string {
  return formatSizeSummary(entries, formatKnownBytes);
}

/** auswahl des SICHTBAREN tabs, sonst stünde "0 ausgewählt", während in einer
 *  anderen liste 19 einträge markiert sind. */
const selectedHere = computed(() =>
  tab.value === "shaders" ? shaders.selectedEntries : prefixes.selectedEntries,
);
const selectedHereSize = computed(() => displaySize(selectedHere.value));
const deleteBlockedHere = computed(() =>
  cleanup.orphanDeleteBlocked(tab.value === "shaders" ? "shadercache" : "compatdata"),
);

async function confirmDeleteOrphans() {
  // der rescan läuft IM store (deleteOrphans), ein zweiter hier würde die
  // dort gesammelten löschfehler wieder zurücksetzen.
  await cleanup.deleteOrphans(selectedHere.value, 0, (paths) => {
    for (const path of paths) selected.delete(path);
  });
}

function deleteShadersAll() {
  // alle shader-caches leeren, selections-umweg unnötig: der store bestätigt
  // über den in-app-dialog (confirmStore).
  cleanup.deleteOrphansAll(shadercacheOrphans.value).catch((error: unknown) => {
    logError("Shader-Bereinigung fehlgeschlagen", error);
  });
}

const busy = computed(() => cleanup.scanning || cleanup.deleting.size > 0);
const destructiveBusy = computed(() => busy.value || confirm.reserved || confirm.busy);

// ---- papierkorb ----

const trashSelectedSize = computed(() => displaySize(trashSelection.selectedEntries));

const trashDeleting = ref(false);

/** all: der „papierkorb leeren“-knopf (löscht alles, unabhängig von der
 *  auswahl); sonst nur die ausgewählten einträge. */
async function deleteTrashEntries(all: boolean) {
  trashDeleting.value = true;
  const onConfirmed = (paths: string[]) => {
    for (const path of paths) trashSelection.selected.delete(path);
  };
  try {
    if (all) {
      await cleanup.emptyTrash(onConfirmed);
    } else {
      await cleanup.deleteTrashEntries([...trashSelection.selectedEntries], 0, onConfirmed);
    }
  } finally {
    trashDeleting.value = false;
  }
}

const tabCount = (id: Tab) =>
  id === "shaders"
    ? shadercacheOrphans.value.length
    : id === "prefixes"
      ? compatdataOrphans.value.length
      : cleanup.trash.length;

const tabLabel = (id: Tab) =>
  id === "shaders"
    ? t("cleanup.shaderCaches")
    : id === "prefixes"
      ? t("cleanup.winePrefixes")
      : t("cleanup.trash");
</script>

<template>
  <section class="cv">
    <header class="bar">
      <div class="title">
        <span class="label">{{ t("cleanup.label") }}</span>
        <h1>{{ t("cleanup.orphanedData") }}</h1>
      </div>
      <button class="scan-btn" type="button" :disabled="busy" @click="cleanup.scanOrphans()">
        {{ cleanup.scanning ? t("cleanup.searching") : t("cleanup.searchButton") }}
      </button>
    </header>
    <div
        v-if="cleanup.ignoredMissingLibs.length && !cleanup.pathMissingLibs.length"
        class="ignored"
    >
        <span :title="cleanup.ignoredMissingLibs.join('\n')">
          {{ t("cleanup.ignoredMissingNote", { n: cleanup.ignoredMissingLibs.length }) }}
        </span>
      <button class="sel-all" type="button" @click="cleanup.unignoreMissingLibs()">
        {{ t("cleanup.ignoredMissingUndo") }}
      </button>
    </div>


    <div v-if="cleanup.error" class="hint" role="alert">{{ cleanup.error }}</div>

    <!-- tabs: eine liste sichtbar, eine aktionsleiste, kein endloses scrollen -->
    <div class="tabs" role="tablist" :aria-label="t('cleanup.tabsLabel')">
      <button
        v-for="(id, i) in TABS"
        :key="id"
        :ref="(el) => setTabRef(el, i)"
        type="button"
        class="tab"
        :class="{ on: tab === id }"
        role="tab"
        :id="`cv-tab-${id}`"
        :aria-selected="tab === id"
        :aria-controls="`cv-panel-${id}`"
        :tabindex="tab === id ? 0 : -1"
        @click="tab = id"
        @keydown="onTabKeydown($event, i)"
      >
        {{ tabLabel(id) }}
        <span class="tab-count">{{ tabCount(id) }}</span>
      </button>
    </div>

    <!-- alles zwischen kopf und aktionsleiste scrollt; leiste und tabs nicht -->
    <div class="scroller">
      <CleanupNotices :shortcut-hint="tab === 'prefixes'" />

      <!-- ---- shader-caches ---- -->
      <div
        v-show="tab === 'shaders'"
        :aria-busy="cleanup.scanning"
        id="cv-panel-shaders"
        class="panel"
        role="tabpanel"
        aria-labelledby="cv-tab-shaders"
        tabindex="0"
      >
        <OrphanPanel kind="shader" :entries="shadercacheOrphans" :selection="shaders" />
      </div>

      <!-- ---- wine-prefixes ---- -->
      <div
        v-show="tab === 'prefixes'"
        :aria-busy="cleanup.scanning"
        id="cv-panel-prefixes"
        class="panel"
        role="tabpanel"
        aria-labelledby="cv-tab-prefixes"
        tabindex="0"
      >
        <OrphanPanel kind="prefix" :entries="compatdataOrphans" :selection="prefixes" />
      </div>

      <!-- ---- papierkorb ---- -->
      <div
        v-show="tab === 'trash'"
        :aria-busy="cleanup.trashScanning"
        id="cv-panel-trash"
        class="panel"
        role="tabpanel"
        aria-labelledby="cv-tab-trash"
        tabindex="0"
      >
        <TrashPanel :selection="trashSelection" />
      </div>

    </div>

    <!-- footer: außerhalb der scroll-fläche, deshalb immer am unteren rand und
         nie über einer listenzeile. bezieht sich nur auf den sichtbaren tab. -->
    <div v-if="tab !== 'trash' && selectedHere.length + tabCount(tab) > 0" class="actionbar">
      <span class="sel-info" aria-live="polite" data-testid="orphan-selected-info">
        {{ t("cleanup.selectedInfo", { n: selectedHere.length, size: selectedHereSize }) }}
      </span>
      <div class="actionbar-btns">
        <button
          v-if="tab === 'shaders' && shadercacheOrphans.length"
          class="action"
          type="button"
          :disabled="destructiveBusy || deleteBlockedHere"
          @click="deleteShadersAll"
        >
          {{ t("cleanup.cleanAllShaders") }}
        </button>
        <button
          class="action danger"
          type="button"
          :disabled="destructiveBusy || deleteBlockedHere || !selectedHere.length"
          @click="confirmDeleteOrphans"
        >
          {{ t("cleanup.deleteSelected", { n: selectedHere.length }) }}
        </button>
      </div>
    </div>

    <div v-if="tab === 'trash' && cleanup.trash.length" class="actionbar">
      <span class="sel-info" aria-live="polite" data-testid="trash-selected-info">
        {{ t("cleanup.selectedInfo", { n: trashSelection.selectedEntries.length, size: trashSelectedSize }) }}
      </span>
      <div class="actionbar-btns">
        <button
          class="action"
          type="button"
          :disabled="!trashSelection.selectedEntries.length || trashDeleting || confirm.reserved || confirm.busy"
          @click="deleteTrashEntries(false)"
        >
          {{ t("cleanup.trashDeleteEntry") }}
        </button>
        <button
          class="action danger"
          type="button"
          :disabled="!cleanup.trash.length || trashDeleting || confirm.reserved || confirm.busy"
          @click="deleteTrashEntries(true)"
        >
          {{ t("cleanup.trashEmpty") }}
        </button>
      </div>
    </div>

  </section>
</template>

<style scoped>
/* die view füllt die höhe von .content (grid-item mit definierter höhe) und
   scrollt INTERN. dadurch ist die aktionsleiste ein echter footer statt
   position:sticky, sie sitzt immer am unteren rand, unabhängig davon wie kurz
   oder lang die liste ist, und kann keine zeile verdecken. */
.cv {
  display: flex; flex-direction: column;
  height: 100%; min-height: 0;
  padding: 20px 24px 0; min-width: 0; overflow-x: hidden;
}
.scroller {
  flex: 1; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  padding-bottom: 8px;
}

.scan-btn {
  align-self: flex-start;
  background: var(--bg-2); color: var(--fg-1);
  border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 10px 16px; font-family: var(--font-body); font-size: 0.875rem; cursor: pointer;

}
.scan-btn:hover:not(:disabled) { color: var(--fg-0); border-color: var(--signal-dim); }
.scan-btn:disabled { opacity: 0.55; cursor: default; }
.scan-btn:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }


/* ---- tabs ---- */
.tabs {
  display: flex; gap: 6px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 4px;
  flex: 0 0 auto;
}
.tab {
  display: flex; align-items: center; gap: 8px;
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--fg-2); cursor: pointer;
  /* großzügige trefferfläche statt kompakter reiter (a11y) */
  padding: 12px 18px;
  font-family: var(--font-body); font-size: 0.9375rem; font-weight: 600;
  margin-bottom: -1px;
}
.tab:hover { color: var(--fg-1); }
.tab:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; border-radius: var(--r-sm); }
.tab.on { color: var(--fg-0); border-bottom-color: var(--signal); }
.tab-count {
  font-family: var(--font-mono); font-size: 0.8125rem; font-weight: 500;
  color: var(--fg-2); background: var(--bg-2);
  border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px;
}
.tab.on .tab-count { color: var(--fg-1); border-color: var(--signal-dim); }

.panel { padding-top: 14px; }
.panel:focus-visible { outline: 2px solid var(--signal); outline-offset: 4px; border-radius: var(--r-sm); }

.sel-all {
  background: none; border: 1px solid var(--line); color: var(--fg-1);
  border-radius: var(--r-sm); padding: 8px 14px;
  font-family: var(--font-body); font-size: 0.875rem; cursor: pointer;
}
.sel-all:hover:not(:disabled) { color: var(--fg-0); border-color: var(--signal-dim); }
.sel-all:disabled { opacity: 0.55; cursor: default; }
.sel-all:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }

.ignored {
  display: flex; align-items: center; gap: 10px;
  background: none; border: none; padding: 0;
  margin: -4px 0 14px;
  font-size: 0.875rem; color: var(--fg-2);
}
.ignored button {
  background: none; border: none; padding: 0;
  color: var(--signal); font-size: 0.875rem; cursor: pointer;
  text-decoration: underline; text-underline-offset: 3px;
}
/* footer der view: liegt außerhalb der scroll-fläche, also immer unten und
   niemals über einer listenzeile. vorher war das position:sticky mit negativem
   margin, dadurch verdeckte die leiste die letzte zeile, die dann nicht mehr
   abwählbar war. */
.actionbar {
  flex: 0 0 auto;
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  margin: 0 -24px; padding: 14px 24px;
  background: var(--bg-1);
  border-top: 1px solid var(--line);
}
.sel-info { font-size: 0.875rem; color: var(--fg-1); }
.actionbar-btns { display: flex; gap: 10px; }

.action {
  background: var(--signal); color: var(--bg-0); border: none;
  border-radius: var(--r-sm); padding: 10px 16px;
  font-family: var(--font-body); font-weight: 600; font-size: 0.875rem; cursor: pointer;
}
.action:hover:not(:disabled) { background: var(--signal-bright); }
.action:disabled { opacity: 0.4; cursor: default; }
.action:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.action.danger {
  background: color-mix(in srgb, var(--tier-borked) 18%, transparent);
  color: #ff9aa0;
  border: 1px solid color-mix(in srgb, var(--tier-borked) 45%, transparent);
}
.action.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--tier-borked) 30%, transparent); }

.hint { color: var(--tier-gold); font-family: var(--font-body); font-size: 0.875rem; margin-bottom: 12px; }


</style>
