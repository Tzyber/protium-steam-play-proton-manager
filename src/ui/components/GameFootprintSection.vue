<script setup lang="ts">
import { computed } from "vue";
import type { useGameFootprint } from "../composables/useGameFootprint";
import type { ExplainTopic } from "../explain";
import { footprintTopics as buildFootprintTopics } from "../gameConfig";
import { t } from "../i18n";
import ExplainInfo from "./ExplainInfo.vue";

const props = defineProps<{
  footprint: ReturnType<typeof useGameFootprint>;
  appId: number;
}>();

// In einem Objekt-Prop werden Refs im Template nicht automatisch entpackt;
// hier destrukturiert, damit das Template dieselben Namen wie im Drawer nutzt.
const {
  state: footprintState,
  result: footprintResult,
  measure: measureFootprint,
  partText: footprintPartText,
  summaryLabel: footprintSummaryLabel,
  summaryText: footprintSummaryText,
} = props.footprint;

const footprintTopics = computed<ExplainTopic[]>(() =>
  buildFootprintTopics(footprintResult.value?.externalCompatdata),
);
</script>

<template>
  <section class="footprint" data-testid="footprint-section" :aria-busy="footprintState === 'measuring'">
    <div class="section-label-explained">
      <h3 class="section-label">{{ t("drawer.footprintTitle") }}</h3>
      <ExplainInfo
        :label="t('drawer.footprintTitle')"
        :topics="footprintTopics"
        :context-key="appId"
      />
    </div>
    <p v-if="footprintState === 'idle'" class="hint">
      {{ t("drawer.footprintExplanation") }}
    </p>
    <button
      class="save footprint-measure"
      data-testid="footprint-measure"
      type="button"
      :disabled="footprintState === 'measuring'"
      @click="measureFootprint"
    >
      {{
        footprintState === "measuring"
          ? t("drawer.footprintMeasuring")
          : t("drawer.footprintMeasure")
      }}
    </button>

    <div v-if="footprintState !== 'idle'" class="footprint-values">
      <div class="footprint-row" data-testid="footprint-game-install">
        <span class="k">{{ t("drawer.footprintGameFiles") }}</span>
        <span data-testid="footprint-game-install-value">{{
          footprintPartText(footprintResult?.gameInstall)
        }}</span>
      </div>
      <div class="footprint-row" data-testid="footprint-compatdata">
        <span class="k">{{ t("drawer.footprintCompatdata") }}</span>
        <span data-testid="footprint-compatdata-value">{{
          footprintPartText(footprintResult?.compatdata)
        }}</span>
      </div>
      <div class="footprint-row" data-testid="footprint-shadercache">
        <span class="k">{{ t("drawer.footprintShadercache") }}</span>
        <span data-testid="footprint-shadercache-value">{{
          footprintPartText(footprintResult?.shadercache)
        }}</span>
      </div>

      <div
        v-if="footprintState === 'measuring'"
        class="footprint-row footprint-summary"
        data-testid="footprint-summary"
      >
        <span class="k">{{ t("drawer.footprintSummaryLabel") }}</span>
        <span>{{ footprintSummaryText() }}</span>
      </div>
      <p
        v-else-if="footprintResult?.summary.status === 'not-measured'"
        class="hint footprint-summary"
        data-testid="footprint-summary"
      >
        {{ t("common.notMeasured") }}
      </p>
      <div v-else class="footprint-row footprint-summary" data-testid="footprint-summary">
        <span class="k">{{ footprintSummaryLabel(footprintResult?.summary ?? { status: "not-measured" }) }}</span>
        <span>{{ footprintSummaryText() }}</span>
      </div>

      <p
        v-if="footprintResult?.externalCompatdata"
        class="hint"
        data-testid="footprint-external-compatdata"
      >
        {{ t("drawer.footprintExternalCompatdata") }}
      </p>
      <p
        v-if="footprintResult?.compatdataNotChecked"
        class="hint"
        data-testid="footprint-compatdata-not-checked"
      >
        {{ t("drawer.footprintCompatdataNotChecked") }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.footprint { margin-top: 20px; }
.footprint .section-label { margin-bottom: 10px; }
.footprint-measure { margin-top: 12px; }
.footprint-values { margin-top: 18px; }
.footprint-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  min-height: 28px;
  color: var(--fg-0);
  font-size: 0.8125rem;
}
.footprint-row .k { margin: 0; color: var(--fg-1); }
.footprint-summary {
  border-top: 1px solid var(--line-soft);
  margin-top: 8px;
  padding-top: 10px;
  font-weight: 600;
}
.footprint-summary .k { color: var(--fg-0); }
.footprint .hint { margin-top: 12px; }

.section-label-explained {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.section-label-explained .section-label {
  margin-bottom: 0;
}
.section-label {
  margin: 0 0 14px;
  font-size: 0.75rem;
  letter-spacing: 0.14em;
  color: var(--fg-1);
  text-transform: uppercase;
}

.save {
  flex-shrink: 0;
  background: var(--bg-2);
  border: 1px solid var(--signal-dim);
  color: var(--signal-bright);
  border-radius: var(--r-sm);
  padding: 11px 15px;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 0.875rem;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s;
}
.save:hover:not(:disabled) { background: var(--bg-3); border-color: var(--signal); }
.save:disabled { opacity: 0.4; cursor: default; }
.save:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
}

.hint { margin: 9px 2px 0; color: var(--fg-2); font-size: 0.8125rem; line-height: 1.55; }

.k { display: block; color: var(--fg-1); font-size: 0.875rem; margin-bottom: 7px; }
</style>
