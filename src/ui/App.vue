<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from "vue";
import AppSidebar from "./components/AppSidebar.vue";
import ConfirmDialogHost from "./components/ConfirmDialogHost.vue";
import NoticeRail from "./components/NoticeRail.vue";
import { logError } from "./diagnostics";
import { locale, t } from "./i18n";
import { ports } from "./ports";
import { serializeSettings } from "./settings";
import { useConfirmStore } from "./stores/confirmStore";
import { useLibraryStore } from "./stores/libraryStore";
import { useScanStore } from "./stores/scanStore";
import { useUiStore } from "./stores/uiStore";
import CleanupView from "./views/CleanupView.vue";
import HistoryView from "./views/HistoryView.vue";
import LibraryView from "./views/LibraryView.vue";
import ProtonManagerView from "./views/ProtonManagerView.vue";

const scan = useScanStore();
const ui = useUiStore();
const lib = useLibraryStore();
const confirm = useConfirmStore();

onMounted(() => {
  scan.runScan();
});

// dialoge (bestätigung, detail-drawer, erklär-panel) sperren den hintergrund
// für screenreader + tab (inert). zentral hier, weil sie per teleport
// ausserhalb von .app-background liegen und fokussierbar bleiben. der
// bestätigungs-host hängt einmal hier, ausserhalb der view-weiche, weil
// pending den wechsel überlebt. die sperre wird aus dem zustand abgeleitet,
// statt von jedem dialog gesetzt und geräumt zu werden: sonst hebt das
// schliessen eines verschachtelten dialogs (erklärung im offenen drawer) die
// sperre des anderen auf.
// Der Drawer zählt nur als offen, solange seine Auswahl im aktuellen Scan
// auflösbar ist: fällt das Spiel durch einen Rescan aus dem Snapshot (oder
// wurde die Ansicht gewechselt), bliebe die Sperre sonst stehen und der
// Hauptinhalt wäre dauerhaft inert.
const drawerOpen = computed(() => {
  const appId = ui.selectedAppId;
  if (appId === null) return false;
  return scan.result?.games.some((entry) => entry.appId === appId) === true;
});

watch(
  () => [confirm.pending !== null, drawerOpen.value, ui.explanationCount > 0] as const,
  ([confirmOpen, gameOpen, explanationOpen]) => {
    ui.inertMain = confirmOpen || gameOpen || explanationOpen;
  },
  { immediate: true },
);

// view-wechsel: h1 der neuen view fokussieren, damit screenreader den titel ansagen
watch(
  () => ui.activeView,
  async () => {
    await nextTick();
    const h1 = document.querySelector<HTMLElement>(".content h1");
    if (!h1) return;
    h1.tabIndex = -1;
    h1.focus({ preventScroll: true });
    h1.addEventListener(
      "blur",
      () => {
        h1.removeAttribute("tabindex");
      },
      { once: true },
    );
  },
);
// Ohne immediate: ein erster Start ohne Datei schreibt nicht.
watch(
  () => [locale.value, ui.activeView, lib.sortKey, lib.sortDir] as const,
  ([language, view, sortKey, sortDir]) => {
    void ports.settings
      .save(serializeSettings({ language, view, sortKey, sortDir }))
      .catch((err) => {
        logError("Einstellungen konnten nicht gespeichert werden", err);
      });
  },
);
</script>

<template>
  <div class="app-background" :inert="ui.inertMain || undefined">
    <a class="skip-link" href="#main-content">{{ t("app.skipToContent") }}</a>
    <div class="shell">
      <AppSidebar />

      <main id="main-content" class="content" tabindex="-1">
        <NoticeRail />
        <LibraryView v-if="ui.activeView === 'library'" />
        <ProtonManagerView v-else-if="ui.activeView === 'proton'" />
        <CleanupView v-else-if="ui.activeView === 'cleanup'" />
        <HistoryView v-else-if="ui.activeView === 'history'" />
      </main>
    </div>
  </div>
  <ConfirmDialogHost />
</template>

<style scoped>
.skip-link {
  position: absolute;
  top: -100%;
  left: 8px;
  z-index: 100;
  background: var(--signal);
  color: var(--on-signal);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--r-sm);
  font-family: var(--font-body);
  font-weight: 600;
  font-size: var(--text-md);
  text-decoration: none;
}
.skip-link:focus-visible {
  top: 8px;
}

.app-background { height: 100%; }
.shell { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: 100%; }
@media (max-width: 1199px) {
  .shell { --sidebar-w: var(--sidebar-w-compact); }
}

.content {
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
}
</style>

<!-- globale .bar-basis aller views (header-zeile oben). gap bleibt view-lokal:
     nur die library braucht ihn, die anderen .bar verteilen via space-between. -->
<style>
.bar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

/* Titelzeile aller Views: eine Quelle, damit kein View anders aussieht. */
.bar .title h1 {
  margin: var(--space-half) 0 0;
  font-family: var(--font-display);
  font-size: var(--text-3xl);
  font-weight: 600;
  letter-spacing: var(--tracking-display);
}
.bar .title .label {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  letter-spacing: var(--tracking-label);
  color: var(--fg-2);
  text-transform: uppercase;
}
</style>
