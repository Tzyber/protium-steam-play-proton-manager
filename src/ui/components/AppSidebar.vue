<script setup lang="ts">
import { computed } from "vue";
import { version as appVersion } from "../../../package.json";
import { t } from "../i18n";
import { useScanStore } from "../stores/scanStore";
import { useUiStore, type ViewId } from "../stores/uiStore";
import ProtiumLogo from "./ProtiumLogo.vue";

const scan = useScanStore();
const ui = useUiStore();

const nav: { id: ViewId; label: string }[] = [
  { id: "library", label: t("app.navLibrary") },
  { id: "proton", label: t("app.navProton") },
  { id: "cleanup", label: t("app.navCleanup") },
  { id: "history", label: t("app.navHistory") },
];

const rootShort = computed(() => {
  const r = scan.result?.steamRoot;
  return r ? r.replace(/^\/home\/[^/]+/, "~") : "-";
});
</script>

<template>
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
</template>

<style scoped>
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
</style>
