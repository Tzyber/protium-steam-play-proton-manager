import { onBeforeUnmount, ref, watch } from "vue";
import { tauriPorts } from "../core/adapters/tauri";
import type { Game } from "../core/types";

// lokale Steam-Cover kommen als Backend-Bytes. Blob-URLs bleiben deshalb
// außerhalb des plugin-fs- und asset-Protokolls.
export function useCover(getGame: () => Game | null) {
  const src = ref<string | null>(null);
  let blobUrl: string | null = null;
  let request = 0;
  let fallbackIndex = 0;

  function revokeBlob(): void {
    if (!blobUrl) return;
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }

  async function load(): Promise<void> {
    const currentRequest = ++request;
    revokeBlob();
    fallbackIndex = 0;
    src.value = null;
    const game = getGame();
    if (!game) return;

    if (game.localHeader) {
      try {
        const bytes = await tauriPorts.fs.readFile(game.localHeader);
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
    revokeBlob();
    fallbackIndex += 1;
    const game = getGame();
    src.value = fallbackIndex === 1 ? (game?.headerImage ?? null) : null;
  }

  watch(
    () => {
      const game = getGame();
      return [game?.appId, game?.localHeader, game?.headerImage] as const;
    },
    () => {
      void load();
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    request += 1;
    revokeBlob();
    src.value = null;
  });

  return { src, onError };
}
