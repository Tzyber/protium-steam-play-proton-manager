import { computed, ref, watch } from "vue";
import { assetUrl } from "../core/adapters/tauri";
import type { Game } from "../core/types";

// kandidaten in reihenfolge: lokaler cache (CDN-unabhängig) → steam-cdn → text.
export function useCover(getGame: () => Game | null) {
  const candidates = computed<string[]>(() => {
    const g = getGame();
    const list: string[] = [];
    if (g?.localHeader) list.push(assetUrl(g.localHeader));
    if (g?.headerImage) list.push(g.headerImage);
    return list;
  });

  const idx = ref(0);
  const src = computed<string | null>(() => candidates.value[idx.value] ?? null);
  function onError() {
    idx.value++; // Nächster Kandidat; danach folgt der Text-Fallback.
  }

  // fehler-fallback-index zurücksetzen: ohne das erbt das nächste spiel den
  // fallback-stand des vorherigen und zeigt trotz vorhandenem cover nur text.
  watch(
    () => getGame()?.appId,
    () => {
      idx.value = 0;
    },
    { immediate: true },
  );

  return { src, onError };
}
