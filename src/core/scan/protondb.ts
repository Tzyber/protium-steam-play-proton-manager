import type { Ports } from "../ports.js";
import { ProtonDbClient } from "../protondb.js";
import type { Game } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface EnrichProtondbOptions {
  shouldApply?: () => boolean;
  onSettled?: (game: Game) => void;
  // option nur für den test (tests/core/scan/protondb.test.ts; K-13).
  sleep?: (ms: number) => Promise<void>;
}

export async function enrichProtondb(
  ports: Ports,
  games: Game[],
  delayMs: number,
  options: EnrichProtondbOptions = {},
): Promise<void> {
  const client = new ProtonDbClient(ports.http, ports.cache);
  const shouldApply = options.shouldApply ?? (() => true);
  const pause = options.sleep ?? sleep;
  for (let index = 0; index < games.length; index += 1) {
    if (!shouldApply()) return;
    const game = games[index];
    // sparse-arrays: eine lücke überspringen statt die ganze anreicherung zu beenden.
    if (!game) continue;
    const result = await client.getSummary(game.appId);
    if (!shouldApply()) return;
    game.protonDb = {
      tier: result?.tier ?? "unknown",
      confidence: result?.confidence ?? "unknown",
    };
    options.onSettled?.(game);
    // null ist ein fehlgeschlagener Abruf, kein Cache-Treffer. Die Pause gilt
    // nur nach HTTP, damit ein 7-Tage-Treffer die Anreicherung nicht drosselt.
    if (result?.fromCache !== true && index + 1 < games.length && delayMs > 0) {
      await pause(delayMs);
      if (!shouldApply()) return;
    }
  }
}
