<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { version as appVersion } from "../../package.json";
import ProtiumLogo from "./components/ProtiumLogo.vue";
import { t } from "./i18n";
import { useScanStore } from "./stores/scanStore";
import { useUiStore, type ViewId } from "./stores/uiStore";
import CleanupView from "./views/CleanupView.vue";
import LibraryView from "./views/LibraryView.vue";
import ProtonManagerView from "./views/ProtonManagerView.vue";

const scan = useScanStore();
const ui = useUiStore();
onMounted(() => scan.runScan());

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

const nav: { id: ViewId; label: string }[] = [
  { id: "library", label: t("app.navLibrary") },
  { id: "proton", label: t("app.navProton") },
  { id: "cleanup", label: t("app.navCleanup") },
];

const rootShort = computed(() => {
  const r = scan.result?.steamRoot;
  return r ? r.replace(/^\/home\/[^/]+/, "~") : "-";
});

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

async function copyError() {
  if (!ui.notification) return;
  try {
    await navigator.clipboard.writeText(ui.notification.message);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    // clipboard nicht verfügbar (unsicherer kontext, keine berechtigung), ignorieren
  }
}
</script>

<template>
  <div class="app-background" :inert="ui.inertMain || undefined">
    <a class="skip-link" href="#main-content">{{ t("app.skipToContent") }}</a>
    <div class="shell">
      <aside class="sidebar">
      <div class="brand">
        <div class="logo"><ProtiumLogo :size="28"/></div>
        <div>
          <div class="name">PROTIUM</div>
          <div class="label">{{ t("app.brandTagline") }}</div>
        </div>
      </div>

      <nav :aria-label="t('app.navAria')">
        <button
          v-for="item in nav"
          :key="item.id"
          class="nav-item"
          :class="{ active: ui.activeView === item.id }"
          type="button"
          :aria-current="ui.activeView === item.id ? 'page' : undefined"
          @click="ui.go(item.id)"
        >
          {{ item.label }}
        </button>
      </nav>

      <div class="readout">
        <div class="row"><span class="label">{{ t("app.root") }}</span><span class="mono val">{{ rootShort }}</span></div>
        <div class="row"><span class="label">{{ t("app.libs") }}</span><span class="mono val">{{ scan.result?.libraries.length ?? "-" }}</span></div>
        <div class="row"><span class="label">{{ t("app.tools") }}</span><span class="mono val">{{ scan.compatTools.length || "-" }}</span></div>
        <div class="row" v-if="scan.elapsedMs"><span class="label">{{ t("app.scan") }}</span><span class="mono val">{{ scan.elapsedMs }} ms</span></div>
        <div class="row readout-version"><span class="label">{{ t("app.version") }}</span><span class="mono val">v{{ appVersion }}</span></div>
      </div>
      </aside>

      <main id="main-content" class="content">
      <transition name="toast" mode="out-in">
        <div v-if="ui.notification" :key="ui.notification.message" class="note toast" role="alert">
          <span class="note-icon" aria-hidden="true">⚠</span>
          <span class="note-msg">{{ ui.notification.message }}</span>
          <button class="note-copy" type="button" :aria-label="copied ? t('app.copied') : t('app.copyError')" @click="copyError">{{ copied ? "✓" : "📋" }}</button>
          <button class="note-close" type="button" :aria-label="t('app.dismissNotification')" @click="ui.dismissNotification()">✕</button>
        </div>
      </transition>
      <LibraryView v-if="ui.activeView === 'library'" />
      <ProtonManagerView v-else-if="ui.activeView === 'proton'" />
      <CleanupView v-else-if="ui.activeView === 'cleanup'" />
      </main>
    </div>
  </div>
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

.sidebar {
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-1);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  padding: 18px 14px;
  gap: 24px;
}

.brand { display: flex; align-items: center; gap: 10px; }
.logo {
  width: 32px; height: 32px;
  display: grid; place-items: center;
  background: var(--signal);
  color: var(--bg-0);
  border-radius: 8px;
  font-size: 0.9375rem;
  box-shadow: 0 0 18px -4px var(--signal-glow);
}
.brand .name { font-family: var(--font-display); font-weight: 700; letter-spacing: 0.06em; font-size: 0.9375rem; }

nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  padding: 9px 12px;
  color: var(--fg-1);
  font-family: var(--font-body);
  font-size: 0.875rem;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}
.nav-item:hover:not(:disabled):not(.active) { background: var(--bg-2); color: var(--fg-0); }
.nav-item.active {
  background: color-mix(in srgb, var(--signal) 14%, transparent);
  color: var(--signal-bright);
  box-shadow: inset 2px 0 0 var(--signal);
}
.readout {
  margin-top: auto;
  display: grid;
  gap: 7px;
  padding: 12px;
  background: var(--bg-0);
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
}
.readout .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.readout .val { color: var(--fg-1); font-size: 0.8125rem; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.content {
  min-height: 0;
  overflow-y: scroll;
  overflow-x: auto;
  scrollbar-gutter: stable;
}

/* notification-toast: sticky oben, copy-button, kein auto-dismiss (nur 30s fallback via store) */
.note.toast {
  position: sticky;
  top: 8px;
  z-index: 10;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  margin: 8px 12px 0;
  background: color-mix(in srgb, var(--tier-borked) 8%, var(--bg-0));
  border: 1px solid var(--tier-borked);
  border-radius: var(--r-sm);
  font-family: var(--font-body);
}
.note-icon { color: var(--tier-borked); font-size: 0.875rem; flex-shrink: 0; margin-top: 2px; }
.note-msg { flex: 1; color: var(--fg-0); font-size: 0.84375rem; line-height: 1.5; word-break: break-word; }
.note-copy, .note-close {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.875rem;
  padding: 0;
  color: var(--fg-2);
  border-radius: 4px;
  font-family: var(--font-body);
  display: grid;
  place-items: center;
  line-height: 1;
}
.note-copy:hover, .note-close:hover { color: var(--fg-0); background: color-mix(in srgb, var(--fg-1) 10%, transparent); }

.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-6px); }
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
</style>
