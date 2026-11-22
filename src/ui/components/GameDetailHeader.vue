<script setup lang="ts">
import type { Game } from "../../core/types";
import { formatBytes } from "../format";
import { t } from "../i18n";
import { tierName } from "../tier";
import ExplainInfo from "./ExplainInfo.vue";
import PlayButton from "./PlayButton.vue";
import TierBadge from "./TierBadge.vue";

defineProps<{
  game: Game;
  titleId: string;
  cover: string | null;
  protonDbLoading: boolean;
  supportCopyState: "idle" | "copying" | "copied" | "failed";
  canCopySupport: boolean;
}>();

const emit = defineEmits<{
  "cover-error": [];
  "copy-support": [];
}>();
</script>

<template>
  <div class="cover">
    <img v-if="cover" :src="cover" :alt="game.name" @error="emit('cover-error')" />
    <div v-else class="cover-fb"><span>{{ game.name }}</span></div>
  </div>

  <div class="head">
    <h2 :id="titleId">{{ game.name }}</h2>
    <TierBadge
      v-if="game.protonDb"
      :tier="game.protonDb.tier"
      :confidence="game.protonDb.confidence"
    />
  </div>
  <p class="meta mono">{{ formatBytes(game.sizeBytes) }} · {{ t("drawer.metaAppId", { appId: game.appId }) }}</p>
  <p class="meta-tier">
    {{ protonDbLoading ? t("drawer.protondbLoading") : tierName(game.protonDb?.tier ?? "unknown") }}
    <ExplainInfo
      :label="t('explain.topics.protondb.title')"
      :topics="['protondb']"
      :context-key="game.appId"
    />
  </p>

  <PlayButton variant="full" :appId="game.appId" :name="game.name" />

  <div class="support-actions">
    <button
      class="save"
      data-testid="support-copy"
      type="button"
      :disabled="!canCopySupport"
      @click="emit('copy-support')"
    >
      {{
        supportCopyState === "copying"
          ? t("drawer.supportCopying")
          : supportCopyState === "copied"
            ? t("drawer.supportCopied")
            : t("drawer.supportCopy")
      }}
    </button>
    <p
      v-if="supportCopyState === 'copied'"
      class="hint support-copy-status"
      data-testid="support-copy-status"
      role="status"
      aria-live="polite"
    >
      {{ t("drawer.supportCopied") }}
    </p>
    <p
      v-else-if="supportCopyState === 'failed'"
      class="hint support-copy-status"
      data-testid="support-copy-error"
      role="alert"
    >
      {{ t("drawer.supportCopyError") }}
    </p>
  </div>
</template>

<style scoped>
.cover {
  aspect-ratio: 460 / 215;
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--bg-3);
  margin-bottom: var(--space-3);
}
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover-fb {
  width: 100%; height: 100%; display: grid; place-items: center; padding: var(--space-3); text-align: center;
  background: linear-gradient(135deg, var(--bg-3), var(--bg-1));
  font-family: var(--font-display); font-weight: 600; color: var(--fg-1);
}

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.head h2 { margin: 0; font-family: var(--font-display); font-size: var(--text-2xl); font-weight: 600; letter-spacing: var(--tracking-display); }
.head :deep(*) { flex-shrink: 0; }
.meta { margin: var(--space-2) 0 var(--space-1); color: var(--fg-2); font-size: var(--text-md); }
.meta-tier { margin: 0 0 var(--space-5); color: var(--fg-1); font-size: var(--text-md); line-height: var(--leading-body); }
.support-actions { margin-top: var(--space-4); }
.support-copy-status { margin-bottom: 0; }
</style>
