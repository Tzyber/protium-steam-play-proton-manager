import { onBeforeUnmount, type Ref, ref, watch } from "vue";
import type { Game } from "../../core/types";
import { ports } from "../ports";

// lokale Steam-Cover kommen als Backend-Bytes. Blob-URLs bleiben deshalb
// außerhalb des plugin-fs- und asset-Protokolls.

export function useCover(getGame: () => Game | null, rootEl?: Ref<HTMLElement | null>) {
  const src = ref<string | null>(null);
  const visible = ref(rootEl === undefined || typeof IntersectionObserver === "undefined");
  let blobUrl: string | null = null;
  let request = 0;
  let observer: IntersectionObserver | null = null;

  function stopObserver(): void {
    observer?.disconnect();
    observer = null;
  }

  function revokeBlob(): void {
    if (!blobUrl) return;
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }

  async function load(): Promise<void> {
    if (!visible.value) return;
    const currentRequest = ++request;
    revokeBlob();
    src.value = null;
    const game = getGame();
    if (!game) return;

    if (game.localHeader) {
      try {
        const bytes = await ports.fs.readFile(game.localHeader);
        if (currentRequest !== request || getGame()?.appId !== game.appId) return;
        const blobBytes = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(blobBytes).set(bytes);
        blobUrl = URL.createObjectURL(new Blob([blobBytes], { type: "image/jpeg" }));
        src.value = blobUrl;
        return;
      } catch {
        // unlesbares lokales cover fällt auf das CDN zurück.
      }
    }

    if (currentRequest === request) src.value = game.headerImage;
  }

  function onError(): void {
    // nur ein unbrauchbares lokales cover hat das CDN-bild als ersatz; scheitert
    // das CDN-bild selbst, bleibt der platzhalter.
    const showedBlob = blobUrl !== null && src.value === blobUrl;
    revokeBlob();
    src.value = showedBlob ? (getGame()?.headerImage ?? null) : null;
  }

  if (rootEl) {
    watch(
      rootEl,
      (el) => {
        stopObserver();
        if (!el || visible.value || typeof IntersectionObserver === "undefined") return;
        observer = new IntersectionObserver(
          (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            visible.value = true;
            stopObserver();
            void load();
          },
          { rootMargin: "200px" },
        );
        observer.observe(el);
      },
      { immediate: true, flush: "post" },
    );
  }

  watch(
    () => {
      const game = getGame();
      return [game?.appId, game?.localHeader, game?.headerImage] as const;
    },
    () => {
      if (!visible.value) return;
      void load();
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    stopObserver();
    request += 1;
    revokeBlob();
    src.value = null;
  });

  return { src, onError };
}
