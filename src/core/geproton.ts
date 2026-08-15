import { joinPath, paths } from "./paths.js";
import type { Cache, FileSystem, Http, System } from "./ports.js";

const RELEASES_URL =
  "https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=15";
const CACHE_KEY = "gh:ge-releases";
const TTL_MS = 60 * 60 * 1000; // Eine Stunde.
const MAX_NOTES = 280;

interface GeAsset {
  name: string;
  url: string;
  size: number;
}

export interface GeRelease {
  tag: string; // = install-verzeichnisname
  name: string;
  publishedAt: string;
  notes: string;
  tarball: GeAsset;
  sha512Url: string | null;
}

interface CacheEntry {
  etag: string | null;
  fetchedAt: number;
  releases: GeRelease[];
}

export type FetchSource = "cache" | "not-modified" | "fresh" | "offline";

export interface FetchResult {
  releases: GeRelease[];
  fetchedAt: number; // letzter echter github-kontakt
  source: FetchSource;
}

interface RawAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}
interface RawRelease {
  tag_name?: unknown;
  name?: unknown;
  published_at?: unknown;
  body?: unknown;
  assets?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseReleases(json: string): GeRelease[] {
  const raw = JSON.parse(json);
  if (!Array.isArray(raw)) return [];
  const out: GeRelease[] = [];
  for (const r of raw as RawRelease[]) {
    const assets = Array.isArray(r.assets) ? (r.assets as RawAsset[]) : [];
    let tarball: GeAsset | null = null;
    let sha512Url: string | null = null;
    for (const a of assets) {
      const name = str(a.name);
      const url = str(a.browser_download_url);
      if (!name || !url) continue;
      if (name.endsWith(".tar.gz")) {
        tarball = { name, url, size: typeof a.size === "number" ? a.size : 0 };
      } else if (name.endsWith(".sha512sum")) {
        sha512Url = url;
      }
    }
    if (!tarball) continue; // ohne tarball unbrauchbar
    const tag = tarball.name.replace(/\.tar\.gz$/, "");
    const body = str(r.body);
    out.push({
      tag,
      name: str(r.name) || tag,
      publishedAt: str(r.published_at),
      notes: body.length > MAX_NOTES ? `${body.slice(0, MAX_NOTES).trimEnd()}…` : body,
      tarball,
      sha512Url,
    });
  }
  return out;
}

// Eine Stunde Cache mit ETag; bei 403 oder Offline bleibt der letzte Stand oder `[]`.
export async function fetchReleases(
  http: Http,
  cache: Cache,
  now: () => number = Date.now,
  force = false,
): Promise<FetchResult> {
  let cached: CacheEntry | null = null;
  try {
    const raw = await cache.get(CACHE_KEY);
    if (raw) cached = JSON.parse(raw) as CacheEntry;
    // Ein ungültiger oder fehlerhafter Cache
    // (releases: null/objekt) wird wie ein miss behandelt statt durchgereicht
    if (cached && !Array.isArray(cached.releases)) cached = null;
  } catch {
    cached = null;
  }

  // force (expliziter klick) umgeht den cache und fragt github, per etag meist billiges 304.
  if (!force && cached && now() - cached.fetchedAt < TTL_MS) {
    return { releases: cached.releases, fetchedAt: cached.fetchedAt, source: "cache" };
  }

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "protium",
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    const res = await http.get(RELEASES_URL, { headers });

    if (res.status === 304 && cached) {
      const at = now();
      try {
        await cache.set(
          CACHE_KEY,
          JSON.stringify({ ...cached, fetchedAt: at } satisfies CacheEntry),
        );
      } catch {
        // cache-schreibfehler darf frische daten nicht verwerfen
      }
      return { releases: cached.releases, fetchedAt: at, source: "not-modified" };
    }
    if (!res.ok) {
      // 403/rate-limit → letzter stand
      return {
        releases: cached?.releases ?? [],
        fetchedAt: cached?.fetchedAt ?? now(),
        source: "offline",
      };
    }

    const at = now();
    const releases = parseReleases(res.text);
    try {
      await cache.set(
        CACHE_KEY,
        JSON.stringify({
          etag: res.headers.etag ?? null,
          fetchedAt: at,
          releases,
        } satisfies CacheEntry),
      );
    } catch {
      // cache-schreibfehler darf frische daten nicht verwerfen
    }
    return { releases, fetchedAt: at, source: "fresh" };
  } catch {
    return {
      releases: cached?.releases ?? [],
      fetchedAt: cached?.fetchedAt ?? now(),
      source: "offline",
    };
  }
}

// erster token der .sha512sum-datei ist der hash.
function parseSha512Sum(text: string): string | null {
  const token = text.trim().split(/\s+/)[0];
  return token && /^[0-9a-fA-F]{128}$/.test(token) ? token.toLowerCase() : null;
}

export type InstallPhase = "downloading" | "verifying" | "extracting";

interface InstallOpts {
  steamRoot: string;
  cacheDir: string; // tarball-zwischenspeicher (app-cache)
  release: GeRelease;
  downloadId: string; // korreliert die progress-events
  onPhase?: (phase: InstallPhase) => void;
  /** hash-asset vorhanden, aber nicht lesbar, installation läuft ohne verifikation.
   *  Kein Text-Parameter: Der Core enthält keine Übersetzungen und es gibt nur einen Grund. */
  onWarning?: () => void;
  /** abbruch-abfrage für das fenster VOR dem rust-download. cancel_download kann
   *  nur einen laufenden download treffen (die cancel-registry im backend kennt
   *  eine id erst, wenn download_file sie registriert hat). alles davor, das
   *  holen des hash-assets über netz, wäre sonst nicht abbrechbar und der
   *  abbruch-klick des nutzers würde still verpuffen. */
  isCancelled?: () => boolean;
}

// download → sha512-prüfung → entpacken. tarball wird immer aufgeräumt; wirft bei mismatch.
export async function installRelease(
  ports: { fs: FileSystem; http: Http; system: System },
  opts: InstallOpts,
): Promise<void> {
  const { fs, system } = ports;
  const dest = joinPath(opts.cacheDir, opts.release.tarball.name);

  // "cancelled" im text ist teil des kontrakts: der aufrufer unterscheidet
  // abbruch von fehler an /cancel/i und zeigt dann keine fehlermeldung.
  const abortIfCancelled = () => {
    if (opts.isCancelled?.()) throw new Error("cancelled");
  };

  abortIfCancelled();

  // hash-asset optional: fehlt es, wird ohne prüfung installiert
  let expected: string | null = null;
  if (opts.release.sha512Url) {
    try {
      expected = parseSha512Sum(await system.fetchSha512(opts.release.sha512Url));
    } catch {
      expected = null;
    }
    if (!expected) opts.onWarning?.(); // asset da, aber unlesbar → ohne verifikation
  }

  try {
    abortIfCancelled(); // netz-abruf oben kann lange dauern
    opts.onPhase?.("downloading");
    const actual = await system.downloadFile(opts.release.tarball.url, dest, opts.downloadId);
    if (expected) {
      opts.onPhase?.("verifying");
      if (actual.toLowerCase() !== expected) {
        throw new Error(
          `checksum stimmt nicht (erwartet ${expected.slice(0, 12)}…, war ${actual.slice(0, 12)}…)`,
        );
      }
    }
    abortIfCancelled();
    opts.onPhase?.("extracting");
    // residuum (bewusst offen): der hash oben wird auf dem download-STREAM
    // berechnet, entpackt wird danach die DATEI auf der platte. wer zwischen
    // prüfung und extraktion schreibzugriff auf den app-cache hat, kann den
    // tarball tauschen, die prüfung deckt das nicht ab. gleiches threat-model
    // wie der rest der app (lokaler prozess mit unseren rechten); schliessbar
    // nur durch hashen des geöffneten fd im backend.
    await system.extractTarball(dest, paths.compatToolsDir(opts.steamRoot));
  } finally {
    await fs.remove(dest).catch(() => {}); // tarball immer weg
  }
}
