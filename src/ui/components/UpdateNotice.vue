<script setup lang="ts">
import { onMounted, ref } from "vue";
import { version as appVersion } from "../../../package.json";
import { openExternal, tauriPorts } from "../../core/adapters/tauri";
import { checkForUpdate, UPDATE_RELEASE_URL } from "../../core/update";
import { logError } from "../diagnostics";
import { t } from "../i18n";
import { useUiStore } from "../stores/uiStore";

const ui = useUiStore();
const updateVersion = ref<string | null>(null);

onMounted(() => {
  void checkForUpdate(tauriPorts.http, appVersion)
    .then((version) => {
      updateVersion.value = version;
    })
    .catch((error: unknown) => logError("Update-Pruefung fehlgeschlagen", error));
});

function openUpdateRelease() {
  const version = updateVersion.value;
  const url = version ? `${UPDATE_RELEASE_URL}/tag/v${version}` : UPDATE_RELEASE_URL;
  void openExternal(url).catch(() => {
    // kein stilles scheitern: ein wirkungsloser klick wäre sonst nicht erklärbar
    ui.showNotification(t("app.openReleaseFailed"));
  });
}
</script>

<template>
  <section v-if="updateVersion" class="update-notice" role="status">
        <span>{{ t("app.updateAvailable", { version: updateVersion, current: appVersion }) }}</span>
        <button class="update-open" type="button" @click="openUpdateRelease">
          {{ t("app.openRelease") }}
        </button>
        <button class="update-close" type="button" :aria-label="t('app.dismissUpdate')" @click="updateVersion = null">✕</button>
      </section>
</template>

<style scoped>
.update-notice {
  position: sticky;
  top: 8px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin: 8px 12px 0;
  background: color-mix(in srgb, var(--signal) 12%, var(--bg-0));
  border: 1px solid var(--signal-dim);
  border-radius: var(--r-sm);
  color: var(--fg-0);
  font-size: 0.84375rem;
}
.update-open, .update-close {
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  font-family: var(--font-body);
}
.update-open {
  margin-left: auto;
  padding: 6px 9px;
  background: var(--signal);
  color: var(--bg-0);
  font-weight: 600;
}
.update-close {
  width: 32px;
  height: 32px;
  background: transparent;
  color: var(--fg-2);
  font-size: 0.875rem;
}
.update-open:hover { background: var(--signal-bright); }
.update-close:hover { color: var(--fg-0); background: color-mix(in srgb, var(--fg-1) 10%, transparent); }
</style>
