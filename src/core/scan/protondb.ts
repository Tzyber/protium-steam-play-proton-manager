import type { Ports } from "../ports.js";
import { ProtonDbClient } from "../protondb.js";
import type { Game } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function enrichProtondb(ports: Ports, games: Game[], delayMs: number): Promise<void> {
  const client = new ProtonDbClient(ports.http, ports.cache);
  for (const game of games) {
    game.protonDb = (await client.getSummary(game.appId)) ?? {
      tier: "unknown",
      confidence: "unknown",
    };
    if (delayMs > 0) await sleep(delayMs);
  }
}
