<script setup lang="ts">
import { computed } from "vue";
import type { Tier } from "../../core/types";
import { t } from "../i18n";
import { tierName, tierTone } from "../tier";

const props = defineProps<{ tier: Tier; confidence?: string }>();

const color = computed(() => tierTone(props.tier));
const name = computed(() => tierName(props.tier));
// Konfidenz sichtbar machen: `title` allein ist für Screenreader und Tastatur
// nicht erreichbar, deshalb zusätzlich als versteckter Text (U-11).
const confidenceText = computed(() =>
  props.confidence ? t("tierBadge.confidence", { confidence: props.confidence }) : null,
);
</script>

<template>
  <span class="tier" :style="{ '--c': color }" :title="confidenceText ?? undefined">
    <span class="dot" aria-hidden="true" />
    {{ name }}<span v-if="confidenceText" class="sr-only">, {{ confidenceText }}</span>
  </span>
</template>

<style scoped>
.tier {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--c);
  background: rgba(8, 9, 14, 0.82);
  border: 1px solid color-mix(in srgb, var(--c) 65%, transparent);
  padding: var(--space-1) var(--space-2);
  border-radius: 999px;
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.55),
    inset 0 0 0 1px rgba(0, 0, 0, 0.35);
  white-space: nowrap;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c);
  box-shadow: 0 0 7px var(--c), 0 0 2px var(--c);
}
</style>
