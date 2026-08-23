import type { Ports } from "../ports.js";
import { ProtonDbClient } from "../protondb.js";
import type { Game } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EnrichProtondbOptions {
  shouldApply?: () => boolean;
  onSettled?: (game: Game) => void;
}

export async function enrichProtondb(
  ports: Ports,
  games: Game[],
  delayMs: number,
  options: EnrichProtondbOptions = {},
): Promise<void> {
  const client = new ProtonDbClient(ports.http, ports.cache);
  const shouldApply = options.shouldApply ?? (() => true);
  for (let index = 0; index < games.length; index += 1) {
    if (!shouldApply()) return;
    const game = games[index];
    if (!game) return;
    const summary = (await client.getSummary(game.appId)) ?? {
      tier: "unknown",
      confidence: "unknown",
    };
    if (!shouldApply()) return;
    game.protonDb = summary;
    options.onSettled?.(game);
    if (index + 1 < games.length && delayMs > 0) {
      await sleep(delayMs);
      if (!shouldApply()) return;
    }
  }
}
