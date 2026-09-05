<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { focusFirstFocusable, restoreFocus, trapFocus } from "../a11y";
import { EXPLAIN_TOPICS, type ExplainTopic } from "../explain";
import { t } from "../i18n";

const props = defineProps<{
  label: string;
  topics: readonly ExplainTopic[];
  contextKey?: number | string;
}>();

const open = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
const uid = useId();
const dialogId = `explain-dialog-${uid}`;
const titleId = `explain-dialog-title-${uid}`;
const descriptionId = `explain-dialog-description-${uid}`;
const entries = computed(() => props.topics.map((topic) => EXPLAIN_TOPICS[topic]));
let opener: HTMLElement | null = null;

function openExplanation(): void {
  if (open.value) return;
  opener = triggerRef.value;
  open.value = true;
  void nextTick(() => {
    if (open.value) focusFirstFocusable(dialogRef.value);
  });
}

function closeExplanation(restore = true): void {
  if (!open.value) return;
  open.value = false;
  if (restore) restoreFocus(opener ?? triggerRef.value);
  opener = null;
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

// nur ein kontextwechsel (anderes spiel) schliesst das offene panel. eine
// geaenderte topics-liste aktualisiert nur den inhalt: sonst verschwindet das
// panel unter dem nutzer, sobald eine laufende messung ein topic ergaenzt.
watch(
  () => props.contextKey,
  () => closeExplanation(false),
);
</script>

<template>
  <span class="explain-info">
    <button
      ref="triggerRef"
      class="explain-trigger"
      data-testid="explain-trigger"
      type="button"
      :aria-label="t('explain.open', { topic: label })"
      :aria-expanded="open"
      :aria-controls="dialogId"
      @click="openExplanation"
    >
      ?
    </button>

    <Teleport to="body">
      <div v-if="open" class="explain-backdrop" @click.self="closeExplanation()">
        <section
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
            <h3 :id="titleId">{{ label }}</h3>
            <button
              class="explain-close"
              data-testid="explain-close"
              type="button"
              @click="closeExplanation()"
            >
              {{ t("explain.close") }}
            </button>
          </div>
          <div :id="descriptionId" class="explain-entries">
            <section v-for="entry in entries" :key="entry.titleKey">
              <h4>{{ t(entry.titleKey) }}</h4>
              <dl>
                <dt>{{ t("explain.sourceLabel") }}</dt>
                <dd>{{ t(entry.sourceKey) }}</dd>
                <dt>{{ t("explain.meaningLabel") }}</dt>
                <dd>{{ t(entry.meaningKey) }}</dd>
                <dt>{{ t("explain.limitLabel") }}</dt>
                <dd>{{ t(entry.limitKey) }}</dd>
              </dl>
            </section>
          </div>
        </section>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.explain-info {
  display: inline-flex;
  vertical-align: middle;
}

.explain-trigger {
  display: inline-grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  border: 1px solid var(--signal-dim);
  border-radius: 50%;
  background: transparent;
  color: var(--signal-bright);
  font: 600 0.8rem var(--font-body);
  line-height: 1;
  cursor: pointer;
}

.explain-trigger:hover,
.explain-trigger:focus-visible {
  border-color: var(--signal);
  background: var(--signal-glow);
}

.explain-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: rgba(4, 5, 9, 0.6);
  backdrop-filter: blur(2px);
}

.explain-dialog {
  width: min(440px, 92vw);
  max-height: 80vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--bg-1);
  color: var(--fg-0);
  box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.7);
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
  font-size: 1.0625rem;
  font-weight: 600;
}

.explain-close {
  flex: 0 0 auto;
  padding: 4px 9px;
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

.explain-entries {
  display: grid;
  gap: 18px;
  margin-top: 18px;
}

.explain-entries h4 {
  margin: 0 0 8px;
  font-family: var(--font-display);
  font-size: 0.875rem;
  font-weight: 600;
}

.explain-entries dl {
  display: grid;
  gap: 2px 10px;
  margin: 0;
  font-size: 0.78rem;
}

.explain-entries dt {
  color: var(--fg-2);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.explain-entries dd {
  margin: 0 0 6px;
  color: var(--fg-1);
}

.explain-entries dd:last-child {
  margin-bottom: 0;
}
</style>
