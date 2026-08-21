<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { focusFirstFocusable, restoreFocus, trapFocus } from "../a11y";
import { t } from "../i18n";

let dialogCount = 0;

const { title, confirmLabel, danger } = defineProps<{
  title: string;
  confirmLabel?: string;
  danger?: boolean;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const dialogRef = ref<HTMLElement | null>(null);
const instanceId = ++dialogCount;
const titleId = `confirm-dialog-title-${instanceId}`;
const contentId = `confirm-dialog-content-${instanceId}`;

let lastFocusedElement: HTMLElement | null = null;

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    emit("cancel");
    return;
  }

  trapFocus(event, dialogRef.value);
}

onMounted(async () => {
  lastFocusedElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  focusFirstFocusable(dialogRef.value);
});

onBeforeUnmount(() => {
  restoreFocus(lastFocusedElement);
});
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="emit('cancel')">
      <div
        ref="dialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="contentId"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <h3 :id="titleId">{{ title }}</h3>
        <div :id="contentId" class="content"><slot /></div>
        <div class="actions">
          <button class="btn ghost" type="button" @click="emit('cancel')">{{ t("common.cancel") }}</button>
          <button class="btn" :class="{ danger }" type="button" @click="emit('confirm')">
            {{ confirmLabel ?? t("common.confirm") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(4, 5, 9, 0.6);
  backdrop-filter: blur(2px);
  display: grid;
  place-items: center;
  z-index: 50;
}
.dialog {
  width: min(460px, 92vw);
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 20px;
  box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.7);
}
h3 {
  margin: 0 0 12px;
  font-family: var(--font-display);
  font-size: 1.0625rem;
  font-weight: 600;
}
.content { color: var(--fg-1); font-size: 0.8125rem; margin-bottom: 18px; }
.actions { display: flex; justify-content: flex-end; gap: 10px; }
.btn {
  border: 1px solid var(--signal);
  background: var(--signal);
  color: #0a0b11;
  border-radius: var(--r-sm);
  padding: 8px 14px;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 0.8125rem;
  cursor: pointer;
}
.btn.ghost { background: transparent; color: var(--fg-1); border-color: var(--line); }
.btn.ghost:hover { color: var(--fg-0); border-color: var(--signal-dim); }
.btn.danger { background: #c03940; border-color: #c03940; color: #fff; }
.btn:hover { background: var(--signal-dim); border-color: var(--signal-dim); }
.btn.danger:hover { background: #a93238; border-color: #a93238; color: #fff; }
.btn:focus-visible,
.btn.ghost:focus-visible {
  outline: 2px solid var(--signal-dim);
  outline-offset: 2px;
}
</style>
