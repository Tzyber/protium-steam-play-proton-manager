<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { focusFirstFocusable, restoreFocus, trapFocus } from "../a11y";
import { type ExplainTopic, getExplainDefinition } from "../explain";
import { t } from "../i18n";

let instanceCount = 0;

const props = defineProps<{
  topic: ExplainTopic;
  contextKey?: number | string;
}>();

const definition = () => getExplainDefinition(props.topic);
const open = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
const instanceId = ++instanceCount;
const dialogId = `explain-dialog-${instanceId}`;
const titleId = `explain-dialog-title-${instanceId}`;
const descriptionId = `explain-dialog-description-${instanceId}`;
let opener: HTMLElement | null = null;

function closeWithoutRestore(): void {
  open.value = false;
  opener = null;
}

function openExplanation(): void {
  if (open.value) return;
  opener = triggerRef.value;
  open.value = true;
  void nextTick(() => {
    if (open.value) focusFirstFocusable(dialogRef.value);
  });
}

function closeExplanation(): void {
  if (!open.value) return;
  open.value = false;
  restoreFocus(opener ?? triggerRef.value);
  opener = null;
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openExplanation();
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeExplanation();
    return;
  }

  if (event.key === "Tab") {
    trapFocus(event, dialogRef.value);
    event.stopPropagation();
  }
}

watch(
  () => [props.topic, props.contextKey] as const,
  ([topic, contextKey], previous) => {
    if (previous && (topic !== previous[0] || contextKey !== previous[1])) {
      closeWithoutRestore();
    }
  },
);
</script>

<template>
  <span class="explain-info">
    <button
      ref="triggerRef"
      class="explain-trigger"
      data-testid="explain-trigger"
      type="button"
      :aria-label="t('explain.open', { topic: t(definition().titleKey) })"
      :aria-expanded="open"
      :aria-controls="dialogId"
      @click="openExplanation"
      @keydown="onTriggerKeydown"
    >
      <span aria-hidden="true" />
    </button>

    <section
      v-if="open"
      :id="dialogId"
      ref="dialogRef"
      class="explain-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-describedby="descriptionId"
      tabindex="-1"
      @keydown="onDialogKeydown"
    >
      <div class="explain-heading">
        <h3 :id="titleId">{{ t(definition().titleKey) }}</h3>
        <button
          class="explain-close"
          data-testid="explain-close"
          type="button"
          :aria-label="t('explain.close')"
          @click="closeExplanation"
        >
          {{ t("explain.close") }}
        </button>
      </div>
      <dl :id="descriptionId" class="explain-details">
        <div>
          <dt>{{ t("explain.sourceLabel") }}</dt>
          <dd>{{ t(definition().sourceKey) }}</dd>
        </div>
        <div>
          <dt>{{ t("explain.meaningLabel") }}</dt>
          <dd>{{ t(definition().meaningKey) }}</dd>
        </div>
        <div>
          <dt>{{ t("explain.limitLabel") }}</dt>
          <dd>{{ t(definition().limitKey) }}</dd>
        </div>
      </dl>
    </section>
  </span>
</template>

<style scoped>
.explain-info {
  position: relative;
  display: inline-block;
  vertical-align: middle;
}

.explain-trigger {
  display: inline-grid;
  place-items: center;
  width: 1.45rem;
  height: 1.45rem;
  padding: 0;
  border: 1px solid var(--signal-dim);
  border-radius: 50%;
  background: transparent;
  color: var(--signal-bright);
  font: 600 0.8rem var(--font-body);
  cursor: pointer;
}

.explain-trigger:hover,
.explain-trigger:focus-visible {
  border-color: var(--signal);
  background: var(--signal-glow);
}

.explain-trigger::before {
  content: "?";
}

.explain-dialog {
  position: absolute;
  z-index: 10;
  top: calc(100% + 8px);
  left: 0;
  width: min(380px, 80vw);
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--bg-1);
  color: var(--fg-0);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45);
}

.explain-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

h3 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
}

.explain-close {
  flex: 0 0 auto;
  padding: 3px 7px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--fg-1);
  font: 0.75rem var(--font-body);
  cursor: pointer;
}

.explain-close:hover,
.explain-close:focus-visible {
  border-color: var(--signal-dim);
  color: var(--fg-0);
}

.explain-details {
  display: grid;
  gap: 9px;
  margin: 14px 0 0;
  font-size: 0.78rem;
}

.explain-details div {
  display: grid;
  gap: 2px;
}

.explain-details dt {
  color: var(--fg-2);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.explain-details dd {
  margin: 0;
  color: var(--fg-1);
}
</style>
