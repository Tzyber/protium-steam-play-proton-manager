<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

withDefaults(defineProps<{ size?: number }>(), { size: 22 });

// query und handler gehören auf die setup-ebene: der mount-hook registriert
// nur noch, der unmount-hook entfernt nur. ein handler, der erst im mount
// entsteht, kann bei einem abbruch zwischen setup und mount nie abgemeldet
// werden.
const mq =
  typeof window === "undefined" ? null : window.matchMedia("(prefers-reduced-motion: reduce)");
const reduced = ref(mq?.matches ?? false);

function onReducedMotionChange(event: MediaQueryListEvent): void {
  reduced.value = event.matches;
}

onMounted(() => mq?.addEventListener("change", onReducedMotionChange));
onBeforeUnmount(() => mq?.removeEventListener("change", onReducedMotionChange));
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    fill="none"
    aria-hidden="true"
  >
    <!-- kern: das eine proton -->
    <circle cx="16" cy="16" r="3.2" fill="currentColor">
      <animate
        v-if="!reduced"
        attributeName="r"
        values="3.2;3.7;3.2"
        dur="2.6s"
        repeatCount="indefinite"
        calcMode="spline"
        keySplines=".4 0 .6 1;.4 0 .6 1"
      />
    </circle>

    <!-- orbit + das eine elektron -->
    <g transform="rotate(-28 16 16)">
      <ellipse
        cx="16"
        cy="16"
        rx="12"
        ry="5.2"
        stroke="currentColor"
        stroke-width="1.4"
        opacity="0.35"
      />
      <circle r="1.9" fill="currentColor" :opacity="!reduced ? undefined : 0.9" :cx="!reduced ? undefined : 4" :cy="!reduced ? undefined : 16">
        <template v-if="!reduced">
          <animateMotion
            dur="3.2s"
            repeatCount="indefinite"
            path="M 4 16 a 12 5.2 0 1 0 24 0 a 12 5.2 0 1 0 -24 0"
          />
          <animate
            attributeName="opacity"
            values="1;0.35;1"
            keyTimes="0;0.5;1"
            dur="3.2s"
            repeatCount="indefinite"
          />
        </template>
      </circle>
    </g>
  </svg>
</template>
