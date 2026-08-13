<script setup lang="ts">
import type { Game } from "../../core/types";
import { formatBytes } from "../format";
import { t } from "../i18n";
import { useUiStore } from "../stores/uiStore";
import { useCover } from "../useCover";
import PlayButton from "./PlayButton.vue";
import TierBadge from "./TierBadge.vue";

const props = defineProps<{ game: Game }>();
const ui = useUiStore();

const { src, onError } = useCover(() => props.game);
</script>

<template>
  <article class="card">
    <button
      class="card-main"
      type="button"
      :aria-label="t('card.openDetails', { name: game.name })"
      @click="ui.openGame(game.appId)"
    >
      <div class="cover">
        <img
          v-if="src"
          :src="src"
          :alt="game.name"
          loading="lazy"
          decoding="async"
          @error="onError"
        />
        <div v-else class="cover-fallback">
          <span class="fb-name">{{ game.name }}</span>
        </div>

        <div class="overlay-top">
          <TierBadge
            v-if="game.protonDb"
            :tier="game.protonDb.tier"
            :confidence="game.protonDb.confidence"
          />
        </div>
      </div>

      <div class="body">
        <h3 :title="game.name">{{ game.name }}</h3>
      </div>
    </button>

    <div class="meta">
      <span class="chip" :class="{ muted: game.compatTool === 'default' }" :title="game.compatTool">
        {{ game.compatTool }}
      </span>
      <div class="meta-right">
        <PlayButton variant="compact" :appId="game.appId" :name="game.name" />
        <span class="size mono">{{ formatBytes(game.sizeBytes) }}</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.card {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
  cursor: default;
  transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
}
.card:has(.card-main:hover) {
  border-color: var(--signal-dim);
  transform: translateY(-2px);
  box-shadow: 0 8px 24px -12px var(--signal-glow);
}
.card:has(.card-main:focus-visible) {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
}

.card-main {
  display: block;
  width: 100%;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.card-main:focus-visible { outline: none; }

.cover {
  position: relative;
  aspect-ratio: 460 / 215;
  background: var(--bg-3);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cover-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  padding: 12px;
  text-align: center;
  background:
    radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, var(--signal) 10%, transparent), transparent 70%),
    linear-gradient(135deg, var(--bg-3), var(--bg-1));
}
.fb-name {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 0.9375rem;
  color: var(--fg-1);
  letter-spacing: -0.01em;
}

.overlay-top { position: absolute; top: 8px; right: 8px; }

.body { padding: 12px 12px 6px; }
h3 {
  margin: 0 0 10px;
  font-family: var(--font-display);
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 12px 12px; }
.chip {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--signal-bright);
  background: color-mix(in srgb, var(--signal) 12%, transparent);
  border: 1px solid var(--signal-dim);
  padding: 4px 8px;
  border-radius: 999px;
  max-width: 62%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip.muted { color: var(--fg-2); background: transparent; border-color: var(--line); }
.size { color: var(--fg-2); font-size: 0.8125rem; white-space: nowrap; }

.meta-right { display: flex; align-items: center; gap: 8px; }
</style>
