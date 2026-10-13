import { ProtiumError } from "./errors.js";
import type { GeRelease } from "./geprotonReleases.js";
import { parseReleases } from "./geprotonReleases.js";
import { isRecord } from "./guards.js";
import type { Cache, Http, InstallPhase, System, TargetArch } from "./ports.js";

// export nur für den spiegel-test (tests/security/github-capability.test.ts; Q-02)
export const RELEASES_URL =
  "https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=15";
const CACHE_KEY = "gh:ge-releases";
const TTL_MS = 60 * 60 * 1000; // Eine Stunde.

// roher body statt geparster releases: jeder lesezugriff parst neu, sonst
// überlebt die parse-ausgabe einer älteren app-version den 304-pfad.
interface CacheEntry {
  etag: string | null;
  fetchedAt: number;
  body: string;
}

export type FetchSource = "cache" | "not-modified" | "fresh" | "offline";

interface FetchResult {
  releases: GeRelease[];
  fetchedAt: number; // letzter echter github-kontakt
  source: FetchSource;
}

async function writeCache(cache: Cache, cacheKey: string, entry: CacheEntry): Promise<void> {
  try {
    await cache.set(cacheKey, JSON.stringify(entry));
  } catch {
    // cache-schreibfehler darf frische daten nicht verwerfen
  }
}

function offlineResult(
  cached: (CacheEntry & { releases: GeRelease[] }) | null,
  now: () => number,
): FetchResult {
  return {
    releases: cached?.releases ?? [],
    fetchedAt: cached?.fetchedAt ?? now(),
    source: "offline",
  };
}

// Eine Stunde Cache mit ETag; bei 403 oder Offline bleibt der letzte Stand oder `[]`.
export async function fetchReleases(
  http: Http,
  cache: Cache,
  targetArch: TargetArch,
  now: () => number = Date.now,
  force = false,
): Promise<FetchResult> {
  const cacheKey = `${CACHE_KEY}:${targetArch}`;
  let cached: (CacheEntry & { releases: GeRelease[] }) | null = null;
  try {
    const raw = await cache.get(cacheKey);
    if (raw) {
      const entry: unknown = JSON.parse(raw);
      // shape-prüfung statt blindem cast (K-14): ein ungültiger oder fehlerhafter
      // Cache (fremde form, body kein string) wird wie ein miss behandelt.
      if (
        isRecord(entry) &&
        typeof entry.fetchedAt === "number" &&
        typeof entry.body === "string"
      ) {
        cached = {
          etag: typeof entry.etag === "string" ? entry.etag : null,
          fetchedAt: entry.fetchedAt,
          body: entry.body,
          releases: parseReleases(entry.body, targetArch),
        };
      }
    }
  } catch {
    cached = null;
  }

  // force (expliziter klick) umgeht den cache und fragt github, per etag meist billiges 304.
  if (!force && cached && now() - cached.fetchedAt < TTL_MS) {
    return { releases: cached.releases, fetchedAt: cached.fetchedAt, source: "cache" };
  }

  try {
    const res = await http.get(RELEASES_URL, cached?.etag ? { ifNoneMatch: cached.etag } : {});

    if (res.status === 304 && cached) {
      const at = now();
      await writeCache(cache, cacheKey, {
        etag: cached.etag,
        fetchedAt: at,
        body: cached.body,
      });
      return { releases: cached.releases, fetchedAt: at, source: "not-modified" };
    }
    if (!res.ok) {
      // 403/rate-limit → letzter stand
      return offlineResult(cached, now);
    }

    const at = now();
    const releases = parseReleases(res.text, targetArch);
    await writeCache(cache, cacheKey, {
      etag: res.headers.etag ?? null,
      fetchedAt: at,
      body: res.text,
    });
    return { releases, fetchedAt: at, source: "fresh" };
  } catch {
    return offlineResult(cached, now);
  }
}

interface InstallOpts {
  steamRoot: string;
  release: GeRelease;
  downloadId: string; // korreliert die progress-events
  /** phases des installers; typ und werteliste kommen aus ports.ts, der
   *  installer selbst meldet nur "downloading" (K-07). */
  onPhase?: (phase: InstallPhase) => void;
  /** Backend meldet, dass das exakt abgeleitete SHA-Asset mit HTTP 404 fehlt. */
  onWarning?: () => void;
  /** abbruch-abfrage für das fenster vor dem Rust-Download. */
  isCancelled?: () => boolean;
  /** `de` oder `en`. Wählt nur den Backend-Text des Prüfsummen-Dialogs. */
  locale: "de" | "en";
}

// delegiert an das backend (download → sha512-prüfung → swap-schutz → entpacken).
export async function installRelease(ports: { system: System }, opts: InstallOpts): Promise<void> {
  const { system } = ports;

  // der abbruchcode "cancelled" ist teil des kontrakts: protonStore
  // unterscheidet abbruch von fehler ueber parseError(...).code und zeigt
  // dann keine fehlermeldung.
  const abortIfCancelled = () => {
    if (opts.isCancelled?.()) throw new ProtiumError("unavailable", "cancelled", "cancelled");
  };

  abortIfCancelled();
  opts.onPhase?.("downloading");

  const result = await system.installGeProton({
    steamRoot: opts.steamRoot,
    releaseTag: opts.release.tag,
    downloadUrl: opts.release.tarball.url,
    downloadId: opts.downloadId,
    locale: opts.locale,
  });

  if (result === "unverified") {
    opts.onWarning?.();
  }
}
