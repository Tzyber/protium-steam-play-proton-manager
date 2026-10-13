<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from "vue";
import AppSidebar from "./components/AppSidebar.vue";
import ConfirmDialogHost from "./components/ConfirmDialogHost.vue";
import NotificationToast from "./components/NotificationToast.vue";
import UpdateNotice from "./components/UpdateNotice.vue";
import { t } from "./i18n";
import { useConfirmStore } from "./stores/confirmStore";
import { useScanStore } from "./stores/scanStore";
import { useUiStore } from "./stores/uiStore";
import CleanupView from "./views/CleanupView.vue";
import HistoryView from "./views/HistoryView.vue";
import LibraryView from "./views/LibraryView.vue";
import ProtonManagerView from "./views/ProtonManagerView.vue";

const scan = useScanStore();
const ui = useUiStore();
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
</script>

<template>
  <div class="app-background" :inert="ui.inertMain || undefined">
    <a class="skip-link" href="#main-content">{{ t("app.skipToContent") }}</a>
    <div class="shell">
      <AppSidebar />

      <main id="main-content" class="content" tabindex="-1">
      <UpdateNotice />
      <NotificationToast />
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
  color: var(--bg-0);
  padding: 8px 14px;
  border-radius: var(--r-sm);
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 0.875rem;
  text-decoration: none;
}
.skip-link:focus-visible {
  top: 8px;
}

.app-background { height: 100%; }
.shell { display: grid; grid-template-columns: 216px 1fr; grid-template-rows: minmax(0, 1fr); height: 100%; }

.content {
  min-height: 0;
  overflow-y: scroll;
  overflow-x: auto;
  scrollbar-gutter: stable;
}
</style>

<!-- globale .bar-basis aller views (header-zeile oben). gap bleibt view-lokal:
     nur die library braucht ihn, die anderen .bar verteilen via space-between. -->
<style>
.bar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 16px;
}

/* Titelzeile aller Views: eine Quelle, damit kein View anders aussieht. */
.bar .title h1 {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 1.625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.bar .title .label {
  font-family: var(--font-body);
  font-size: 0.8125rem;
  letter-spacing: 0.14em;
  color: var(--fg-2);
  text-transform: uppercase;
}
</style>
