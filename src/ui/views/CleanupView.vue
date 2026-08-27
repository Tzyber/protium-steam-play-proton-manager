<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import type { TrashEntry } from "../../core/trash";
import type { OrphanEntry } from "../../core/types";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { formatBytes } from "../format";
import { getLocale, t } from "../i18n";
import { useCleanupStore } from "../stores/cleanupStore";
import { useConfirmStore } from "../stores/confirmStore";

const cleanup = useCleanupStore();
const confirm = useConfirmStore();

// ---- tabs ----
// drei listen auf einer seite waren nicht mehr bedienbar: bei 19 prefixes musste
// man an der papierkorb-sektion vorbeiscrollen, und zwei sticky-aktionsleisten
// (orphans + papierkorb) lagen übereinander. pro tab genau eine liste und genau
// eine leiste, die sich auf DIESE liste bezieht.
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

onMounted(async () => {
  await cleanup.scanOrphans();
  // papierkorb gleich mitladen, nur lesend, und ohne das sieht der nutzer eine
  // leere sektion und hält sie für den echten stand
  await cleanup.scanTrash();
  // nicht auf einem leeren tab landen
  if (!shadercacheOrphans.value.length) {
    if (compatdataOrphans.value.length) tab.value = "prefixes";
    else if (cleanup.trash.length) tab.value = "trash";
  }
});

// ---- verwaiste daten ----

/** kürzt die mitte: erstes segment + die letzten zwei. der lange
 *  library-prefix wiederholt sich in jeder zeile und trägt keine information,
 *  aber /mnt vs /home muss unterscheidbar bleiben. voller pfad im title. */
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return `/${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

const bySize = (a: OrphanEntry, b: OrphanEntry) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
const shadercacheOrphans = computed(() => [...cleanup.shadercacheOrphans].sort(bySize));
const compatdataOrphans = computed(() => [...cleanup.compatdataOrphans].sort(bySize));

const selected = reactive(new Set<string>());

function toggle(key: string) {
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
}

const shadercacheTotalBytes = computed(() =>
  shadercacheOrphans.value.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
);
const compatdataTotalBytes = computed(() =>
  compatdataOrphans.value.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
);

const shaderAllSelected = computed(
  () =>
    shadercacheOrphans.value.length > 0 &&
    shadercacheOrphans.value.every((o) => selected.has(cleanup.key(o))),
);
const compatAllSelected = computed(() => {
  const candidates = compatdataOrphans.value.filter((o) => !o.potentialShortcut);
  return candidates.length > 0 && candidates.every((o) => selected.has(cleanup.key(o)));
});

/** auswahl-umschalter: alle an- oder alle abwählen, je nach ist-zustand. */
function toggleAll<T>(
  entries: readonly T[],
  set: Set<string>,
  allSelected: boolean,
  keyOf: (e: T) => string,
) {
  for (const e of entries) {
    if (allSelected) set.delete(keyOf(e));
    else set.add(keyOf(e));
  }
}

function selectAllShader() {
  toggleAll(shadercacheOrphans.value, selected, shaderAllSelected.value, (o) => cleanup.key(o));
}

function selectAllCompat() {
  const candidates = compatdataOrphans.value.filter((o) => !o.potentialShortcut);
  toggleAll(candidates, selected, compatAllSelected.value, (o) => cleanup.key(o));
}

const selectedShader = computed(() =>
  shadercacheOrphans.value.filter((o) => selected.has(cleanup.key(o))),
);
const selectedCompat = computed(() =>
  compatdataOrphans.value.filter((o) => selected.has(cleanup.key(o))),
);

/** auswahl des SICHTBAREN tabs, sonst stünde "0 ausgewählt", während in einer
 *  anderen liste 19 einträge markiert sind. */
const selectedHere = computed(() =>
  tab.value === "shaders" ? selectedShader.value : selectedCompat.value,
);
const selectedHereBytes = computed(() =>
  selectedHere.value.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
);

async function confirmDeleteOrphans() {
  // der rescan läuft IM store (deleteOrphans), ein zweiter hier würde die
  // dort gesammelten löschfehler wieder zurücksetzen.
  await cleanup.deleteOrphans(selectedHere.value);
  selected.clear();
}

function deleteShadersAll() {
  // alle shader-caches leeren, selections-umweg unnötig: das backend-gate
  // bestätigt über den native-dialog.
  void cleanup.deleteOrphans(shadercacheOrphans.value);
}

const busy = computed(() => cleanup.scanning || cleanup.deleting.size > 0);

// ---- papierkorb ----

const trashBySize = computed(() =>
  [...cleanup.trash].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)),
);

const trashSelected = reactive(new Set<string>());

function toggleTrash(path: string) {
  if (trashSelected.has(path)) trashSelected.delete(path);
  else trashSelected.add(path);
}

const trashTotalBytes = computed(() =>
  cleanup.trash.reduce((sum, e) => sum + (e.sizeBytes ?? 0), 0),
);

const trashSelectedAll = computed(() => cleanup.trash.filter((e) => trashSelected.has(e.path)));
const trashSelectedBytes = computed(() =>
  trashSelectedAll.value.reduce((sum, e) => sum + (e.sizeBytes ?? 0), 0),
);

const trashDeleting = ref(false);

/** all: der „papierkorb leeren“-knopf (löscht alles, unabhängig von der
 *  auswahl); sonst nur die ausgewählten einträge. */
async function deleteTrashEntries(all: boolean) {
  trashDeleting.value = true;
  try {
    if (all) {
      await cleanup.emptyTrash();
    } else {
      await cleanup.deleteTrashEntries([...trashSelectedAll.value]);
    }
    trashSelected.clear();
  } finally {
    trashDeleting.value = false;
  }
}
/** kurzform für die spalte, der volle satz steht im title-attribut. eine
 *  datumsspalte in flexibler breite hat die zeile über den viewport geschoben. */
function trashDate(ms: number): string {
  return new Date(ms).toLocaleDateString(getLocale() === "de" ? "de-DE" : "en-GB", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  });
}

const trashAllSelected = computed(
  () => trashBySize.value.length > 0 && trashBySize.value.every((e) => trashSelected.has(e.path)),
);

function selectAllTrash() {
  toggleAll(trashBySize.value, trashSelected, trashAllSelected.value, (e) => e.path);
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
        <div v-if="cleanup.blockedBySkipped" class="blocked">
        {{ t("cleanup.scanBlocked") }}
      </div>



      <div v-if="cleanup.pathMissingLibs.length" class="pathmissing">
        <p class="pm-title">{{ t("cleanup.pathMissingTitle") }}</p>
        <ul class="pm-list">
          <li v-for="p in cleanup.pathMissingLibs" :key="p">{{ p }}</li>
        </ul>
        <p class="pm-note">{{ t("cleanup.pathMissingNote") }}</p>
        <button class="pm-btn" type="button" @click="cleanup.dismissPathMissing()">
          {{ t("cleanup.pathMissingDismiss") }}
        </button>
      </div>

      <div v-if="cleanup.shortcutUnreadable" class="blocked">
        {{ t("cleanup.shortcutUnreadableMessage") }}
        <ul class="pm-list">
          <li v-for="p in cleanup.shortcutUnreadablePaths" :key="p" class="mono">{{ p }}</li>
        </ul>
      </div>

      <div v-if="cleanup.incompleteDeletions.length" class="blocked">
        <strong>{{ t("cleanup.incompleteDeletionsTitle") }}</strong>
        <p class="pm-note">{{ t("cleanup.incompleteDeletionsBody") }}</p>
        <p class="pm-note">{{ t("cleanup.incompleteDeletionsHint") }}</p>
        <ul class="pm-list">
          <li v-for="d in cleanup.incompleteDeletions" :key="d.path" class="mono">{{ d.path }}</li>
        </ul>
      </div>

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
        <div class="section-bar">
          <span class="section">
            <span class="count">{{ t("cleanup.total", { size: formatBytes(shadercacheTotalBytes) }) }}</span>
          </span>
          <button
            v-if="shadercacheOrphans.length"
            class="sel-all"
            type="button"
            :aria-pressed="shaderAllSelected"
            @click="selectAllShader()"
          >
            {{ t("cleanup.selectAll") }}
          </button>
        </div>

        <ul v-if="shadercacheOrphans.length" class="list">
          <li
            v-for="o in shadercacheOrphans"
            :key="cleanup.key(o)"
          >
            <button
              type="button"
              class="row"
              :class="{ on: selected.has(cleanup.key(o)) }"
              :aria-pressed="selected.has(cleanup.key(o))"
              @click="toggle(cleanup.key(o))"
            >
              <span class="box" aria-hidden="true" />
              <span class="rname mono">{{ o.appId }}</span>
              <span class="rpath mono" :title="o.path">{{ shortPath(o.path) }}<span class="sr-only">{{ o.path }}</span></span>
              <span class="rsize mono">{{ o.sizeBytes != null ? formatBytes(o.sizeBytes) : "…" }}</span>
            </button>
          </li>
        </ul>
        <div v-else-if="cleanup.scanning" class="empty">{{ t("cleanup.searching") }}</div>
        <div v-else class="empty">{{ t("cleanup.empty") }}</div>
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
        <div class="section-bar">
          <span class="section">
            <span class="warn-label">{{ t("cleanup.winePrefixWarn") }}</span>
            <span class="count">{{ t("cleanup.total", { size: formatBytes(compatdataTotalBytes) }) }}</span>
          </span>
          <button
            v-if="compatdataOrphans.length"
            class="sel-all warn"
            type="button"
            :aria-pressed="compatAllSelected"
            @click="selectAllCompat()"
          >
            {{ t("cleanup.selectAll") }}
          </button>
        </div>

        <p class="moved-note">{{ t("cleanup.winePrefixMovedNote") }}</p>

        <ul v-if="compatdataOrphans.length" class="list">
          <li
            v-for="o in compatdataOrphans"
            :key="cleanup.key(o)"
          >
            <button
              type="button"
              class="row"
              :class="{ on: selected.has(cleanup.key(o)) }"
              :aria-pressed="selected.has(cleanup.key(o))"
              @click="toggle(cleanup.key(o))"
            >
              <span class="box" aria-hidden="true" />
              <span class="rname mono">
                {{ o.appId }}
                <span
                  v-if="o.potentialShortcut"
                  class="sc-warn"
                  :title="t('cleanup.potentialShortcutTooltip')"
                  aria-hidden="true"
                >?</span>
                <span v-if="o.potentialShortcut" class="sr-only">{{ t('cleanup.potentialShortcutTooltip') }}</span>
              </span>
              <span class="rpath mono" :title="o.path">{{ shortPath(o.path) }}<span class="sr-only">{{ o.path }}</span></span>
              <span class="rsize mono">{{ o.sizeBytes != null ? formatBytes(o.sizeBytes) : "…" }}</span>
            </button>
          </li>
        </ul>
        <div v-else-if="cleanup.scanning" class="empty">{{ t("cleanup.searching") }}</div>
        <div v-else class="empty">{{ t("cleanup.empty") }}</div>
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
        <div class="section-bar">
          <span class="section">
            <span class="count">{{ t("cleanup.total", { size: formatBytes(trashTotalBytes) }) }}</span>
          </span>
          <div class="section-actions">
            <button
              v-if="trashBySize.length"
              class="sel-all"
              type="button"
              :aria-pressed="trashAllSelected"
              @click="selectAllTrash()"
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
                ? t("cleanup.trashLibError", { dir: l.dir || l.library, msg: l.error })
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
          <li
            v-for="e in trashBySize"
            :key="e.path"
          >
            <button
              type="button"
              class="row with-date"
              :class="{ on: trashSelected.has(e.path) }"
              :aria-pressed="trashSelected.has(e.path)"
              @click="toggleTrash(e.path)"
            >
              <span class="box" aria-hidden="true" />
              <span class="rname mono">{{ e.appId }}</span>
              <span class="rpath mono" :title="e.path">{{ shortPath(e.path) }}<span class="sr-only">{{ e.path }}</span></span>
              <span
                class="rdate mono"
                :title="t('cleanup.trashTrashedAt', { date: trashDate(e.trashedAt) })"
              >{{ trashDate(e.trashedAt) }}</span>
              <span class="rsize mono">{{ e.sizeBytes != null ? formatBytes(e.sizeBytes) : "…" }}</span>
            </button>
          </li>
        </ul>
        <div v-else-if="!cleanup.trashScanning" class="empty">
          {{ t("cleanup.trashEmptyState") }}
        </div>
      </div>

    </div>

    <!-- footer: außerhalb der scroll-fläche, deshalb immer am unteren rand und
         nie über einer listenzeile. bezieht sich nur auf den sichtbaren tab. -->
    <div v-if="tab !== 'trash' && selectedHere.length + tabCount(tab) > 0" class="actionbar">
      <span class="sel-info" aria-live="polite">
        {{ t("cleanup.selectedInfo", { n: selectedHere.length, size: formatBytes(selectedHereBytes) }) }}
      </span>
      <div class="actionbar-btns">
        <button
          v-if="tab === 'shaders' && shadercacheOrphans.length"
          class="action"
          type="button"
          :disabled="busy"
          @click="deleteShadersAll"
        >
          {{ t("cleanup.cleanAllShaders") }}
        </button>
        <button
          class="action danger"
          type="button"
          :disabled="busy || !selectedHere.length"
          @click="confirmDeleteOrphans"
        >
          {{ t("cleanup.deleteSelected", { n: selectedHere.length }) }}
        </button>
      </div>
    </div>

    <div v-if="tab === 'trash' && cleanup.trash.length" class="actionbar">
      <span class="sel-info" aria-live="polite">
        {{ t("cleanup.selectedInfo", { n: trashSelectedAll.length, size: formatBytes(trashSelectedBytes) }) }}
      </span>
      <div class="actionbar-btns">
        <button
          class="action"
          type="button"
          :disabled="!trashSelectedAll.length || trashDeleting"
          @click="deleteTrashEntries(false)"
        >
          {{ t("cleanup.trashDeleteEntry") }}
        </button>
        <button
          class="action danger"
          type="button"
          :disabled="!cleanup.trash.length || trashDeleting"
          @click="deleteTrashEntries(true)"
        >
          {{ t("cleanup.trashEmpty") }}
        </button>
      </div>
    </div>

  </section>

  <ConfirmDialog
    v-if="confirm.pending"
    :title="confirm.pending.title"
    :busy="confirm.busy"
    danger
    :confirm-label="t('common.delete')"
    @confirm="confirm.confirm()"
    @cancel="confirm.cancel()"
  >
    <p class="consequences">{{ confirm.pending.message }}</p>
  </ConfirmDialog>
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
.title h1 { margin: 2px 0 0; font-family: var(--font-display); font-size: 1.625rem; font-weight: 600; letter-spacing: -0.02em; }
.title .label { font-family: var(--font-body); font-size: 0.8125rem; letter-spacing: 0.14em; color: var(--fg-2); text-transform: uppercase; }

.scan-btn {
  align-self: flex-start;
  background: var(--bg-2); color: var(--fg-1);
  border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 10px 16px; font-family: var(--font-body); font-size: 0.875rem; cursor: pointer;

}
.scan-btn:hover:not(:disabled) { color: var(--fg-0); border-color: var(--signal-dim); }
.scan-btn:disabled { opacity: 0.55; cursor: default; }
.scan-btn:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }

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

.pathmissing {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: 14px 16px;
  margin-bottom: 16px;
}
.pm-title { margin: 0 0 8px; color: var(--signal); font-size: 0.875rem; }
.pm-list { margin: 0 0 10px; padding-left: 18px; }
.pm-list li { color: var(--fg-1); font-family: var(--font-mono); font-size: 0.875rem; line-height: 1.6; }
.pm-note { margin: 0 0 12px; color: var(--fg-2); font-size: 0.875rem; line-height: 1.5; }
.pm-btn {
  background: var(--signal); border: none; color: var(--bg-0);
  border-radius: var(--r-sm); padding: 10px 15px;
  font-family: var(--font-body); font-weight: 600; font-size: 0.875rem; cursor: pointer;
}
.pm-btn:hover { background: var(--signal-bright); }
.pm-btn:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }



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
  font-family: var(--font-mono); font-size: 0.75rem; font-weight: 400;
  color: var(--fg-2); background: var(--bg-2);
  border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px;
}
.tab.on .tab-count { color: var(--fg-1); border-color: var(--signal-dim); }

.panel { padding-top: 14px; }
.panel:focus-visible { outline: 2px solid var(--signal); outline-offset: 4px; border-radius: var(--r-sm); }

.section-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; min-height: 34px; }
.section {
  font-family: var(--font-display); font-size: 1rem; font-weight: 600; color: var(--fg-1);
  display: flex; align-items: center; gap: 10px;
}
.section .count { color: var(--fg-2); font-weight: 400; }
.section .warn-label {
  font-family: var(--font-body); font-size: 0.875rem; color: var(--fg-1);
  border: 1px solid color-mix(in srgb, var(--tier-gold) 45%, transparent);
  border-radius: 999px; padding: 2px 9px;
}
.section-actions { display: flex; gap: 8px; }

.sel-all {
  background: none; border: 1px solid var(--line); color: var(--fg-1);
  border-radius: var(--r-sm); padding: 8px 14px;
  font-family: var(--font-body); font-size: 0.875rem; cursor: pointer;
}
.sel-all:hover:not(:disabled) { color: var(--fg-0); border-color: var(--signal-dim); }
.sel-all:disabled { opacity: 0.55; cursor: default; }
.sel-all:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.sel-all.warn:hover:not(:disabled) { border-color: var(--tier-gold); color: var(--tier-gold); }

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
.libstatus {
  font-family: var(--font-mono); font-size: 0.875rem; color: var(--fg-1); line-height: 1.7;
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--r-sm); padding: 12px 16px; margin-bottom: 14px;
  overflow-wrap: anywhere;
}

.list { display: grid; gap: 6px; list-style: none; padding: 0; margin: 0; }
.list > li { display: contents; }

/* ganze zeile ist die klickfläche (a11y: große trefferfläche statt mini-checkbox).
   grid statt flex: die pfad-spalte ist minmax(0, 1fr) und kann damit NICHT über
   den container hinauswachsen. vorher schob die zusätzliche datumsspalte im
   papierkorb die zeile aus dem viewport. beide listen nutzen dieselben
   spaltenbreiten, damit sie identisch aussehen. */
.row {
position: relative;
  display: grid;
  /* rem statt px: skaliert mit root-schriftgröße (text-only-zoom). ch wäre hier
     falsch, .row erbt Inter vom body, nicht Space Mono. ch in Inter (14px) ≈ 7px,
     damit wäre 9ch ≈ 63px statt 90px. 5.6rem / 4.6rem bei root 16px = 90px / 74px. */
  grid-template-columns: 20px 5.6rem minmax(0, 1fr) 5.6rem;
  align-items: center; gap: 14px;
  width: 100%; text-align: left;
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--r-sm); padding: 12px 14px; cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
  /* damit tastatur-fokus nicht unter der sticky leiste landet */
  scroll-margin-bottom: 80px;
}
/* papierkorb: datumsspalte zwischen pfad und größe, feste breite */
.row.with-date { grid-template-columns: 20px 5.6rem minmax(0, 1fr) 4.6rem 5.6rem; }
.row:hover { border-color: var(--signal-dim); background: var(--bg-3); }
.row:hover .rdate {
  color: var(--fg-1);
}
.row:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.row.on { border-color: var(--signal); background: color-mix(in srgb, var(--signal) 10%, var(--bg-2)); }

.box {
  flex-shrink: 0; width: 20px; height: 20px; border-radius: 5px;
  border: 2px solid var(--fg-2); background: transparent;
  display: grid; place-items: center; transition: all 0.12s;
}
.row.on .box { border-color: var(--signal); background: var(--signal); }
.row.on .box::after {
  content: ""; width: 5px; height: 9px; margin-top: -2px;
  border: solid var(--bg-0); border-width: 0 2px 2px 0; transform: rotate(45deg);
}

.rname { font-size: 0.9375rem; color: var(--fg-0); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-warn {
  display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center;
  border-radius: 50%; font-size: 0.8125rem; font-weight: 600; margin-left: 4px;
  background: color-mix(in srgb, var(--tier-gold) 20%, transparent);
  color: #f5d678; border: 1px solid color-mix(in srgb, var(--tier-gold) 40%, transparent);
}
.rpath {
  min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--fg-1); font-size: 0.875rem;
}
.rsize { color: var(--fg-1); font-size: 0.875rem; white-space: nowrap; text-align: right; }
.rdate { color: var(--fg-2); font-size: 0.875rem; white-space: nowrap; text-align: right; }

.moved-note {
  color: var(--fg-2); font-size: 0.875rem; font-family: var(--font-body);
  margin: 0 0 10px; font-style: italic;
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
.empty { color: var(--fg-2); font-family: var(--font-body); font-size: 0.875rem; padding: 32px 0; text-align: center; }

.paths { margin: 8px 0 0; padding-left: 18px; color: var(--fg-1); max-height: 160px; overflow-y: auto; }
.paths li { font-size: 0.75rem; margin: 2px 0; }
.saveurge {
  background: color-mix(in srgb, var(--tier-borked) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--tier-borked) 35%, transparent);
  color: #ff9aa0; border-radius: var(--r-sm);
  padding: 10px 14px; font-family: var(--font-display); font-size: 0.875rem; font-weight: 600; margin-bottom: 12px;
}
.consequences { white-space: pre-line; margin: 0; max-height: 260px; overflow-y: auto; }

</style>
