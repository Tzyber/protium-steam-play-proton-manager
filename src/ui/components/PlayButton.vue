<script setup lang="ts">
import { launchGame } from "../../core/adapters/tauri";
import { errText } from "../../core/errtext";
import { t } from "../i18n";
import { useUiStore } from "../stores/uiStore";

const props = defineProps<{
  appId: number;
  name: string;
  variant: "compact" | "full";
}>();

function launch() {
  const ui = useUiStore();
  void launchGame(props.appId).catch((e: unknown) => {
    ui.showNotification(t("drawer.launchFailed", { error: errText(e) }));
  });
}
</script>

<template>
  <button
    class="play"
    :class="variant"
    type="button"
    :title="variant === 'full'
      ? t('drawer.launch', { name })
      : t('card.launch', { name })"
    :aria-label="variant === 'full'
      ? t('drawer.launch', { name })
      : t('card.launch', { name })"
    @click.stop="launch"
  >
    <template v-if="variant === 'full'">{{ t("drawer.play") }}</template>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" /></svg>
  </button>
</template>

<style scoped>
.play {
  padding: 0;
  cursor: pointer;
  border: 1px solid var(--signal-dim);
  transition: background 0.15s, color 0.15s, transform 0.1s, filter 0.15s;
}
.play:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
}

/* compact (GameCard) */
.compact {
  display: grid;
  place-items: center;
  width: 45px;
  height: 30px;
  color: var(--signal-bright);
  background: color-mix(in srgb, var(--signal) 12%, transparent);
  border-radius: 10px;
}
.compact svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
  margin-left: 1px;
}
.compact:hover {
  background: var(--signal);
  color: var(--bg-1);
}
.compact:active {
  transform: scale(0.92);
}

/* full (GameDetailDrawer) */
.full {
  width: 100%;
  background: var(--signal);
  border-color: var(--signal);
  color: var(--bg-0);
  border-radius: var(--r-sm);
  padding: 13px 14px;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 0.9375rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.full svg {
  width: 15px;
  height: 15px;
  fill: currentColor;
}
.full:hover {
  filter: brightness(1.12);
}
.full:active {
  transform: scale(0.98);
}
</style>
