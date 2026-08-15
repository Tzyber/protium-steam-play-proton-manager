import type { Cache, Http } from "./ports.js";
import type { Tier } from "./types.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_TIERS: readonly Tier[] = ["platinum", "gold", "silver", "bronze", "borked", "unknown"];

// Der Host muss dem HTTP-Scope entsprechen (`www`, nicht Apex), sonst blockiert Tauri.
const BASE = "https://www.protondb.com/api/v1/reports/summaries";

/** öffentliche protondb-seite eines spiels (reports mit OS/proton-version/text). */
export function protonDbAppUrl(appId: number): string {
  return `https://www.protondb.com/app/${appId}`;
}

interface CacheEntry {
  tier: Tier;
  confidence: string;
  fetchedAt: number;
}

function normalizeTier(raw: unknown): Tier {
  return typeof raw === "string" && (VALID_TIERS as string[]).includes(raw)
    ? (raw as Tier)
    : "unknown";
}

export class ProtonDbClient {
  constructor(
    private http: Http,
    private cache: Cache,
    private now: () => number = Date.now,
  ) {}

  // 404, Offline oder defekte Daten ergeben `null`; der Aufrufer setzt `unknown`.
  async getSummary(appId: number): Promise<{ tier: Tier; confidence: string } | null> {
    const key = `protondb:${appId}`;
    try {
      const cached = await this.cache.get(key);
      if (cached) {
        const entry = JSON.parse(cached) as CacheEntry;
        // Der Cache wird wie frische Daten validiert: Tier normalisieren,
        // confidence-typ geprüft), ein vergifteter cache darf keine fremden
        // tier-werte durchreichen
        if (this.now() - entry.fetchedAt < TTL_MS) {
          return {
            tier: normalizeTier(entry.tier),
            confidence: typeof entry.confidence === "string" ? entry.confidence : "unknown",
          };
        }
      }
    } catch {
      // kaputt → wie cache-miss
    }

    try {
      const res = await this.http.get(`${BASE}/${appId}.json`);
      if (!res.ok) return null; // insb. 404 = kein report
      const body = JSON.parse(res.text) as { tier?: unknown; confidence?: unknown };
      const result = {
        tier: normalizeTier(body.tier),
        confidence: typeof body.confidence === "string" ? body.confidence : "unknown",
      };
      const entry: CacheEntry = { ...result, fetchedAt: this.now() };
      try {
        await this.cache.set(key, JSON.stringify(entry));
      } catch {
        // cache-schreibfehler darf frische daten nicht verwerfen
      }
      return result;
    } catch {
      return null; // netzwerkfehler → degradieren
    }
  }
}
