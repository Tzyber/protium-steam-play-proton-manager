import type { Cache, Http, System, TargetArch } from "./ports.js";

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
  /** kanonischer GitHub-Release-Tag aus `tag_name` */
  tag: string;
  name: string;
  publishedAt: string;
  notes: string;
  /** Assetname ohne `.tar.gz`, zugleich autorisierter Installationsname. */
  installName: string;
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

export const MANAGED_GE_NAME_RE = /^GE-Proton[0-9]+-[0-9]+(-(x86_64|aarch64))?$/;

// upstream-snapshot 2026-08-20: suffix-assets ab GE-Proton11-4;
// unsuffixt ist nur die belegte x86_64-legacy-familie bis 11-3.
const LEGACY_MAX_MAJOR = 11;
const LEGACY_MAX_MINOR = 3;

function releaseVersion(name: string): [number, number] | null {
  const match = /^GE-Proton([0-9]+)-([0-9]+)$/.exec(name);
  if (!match) return null;
  const majorText = match[1];
  const minorText = match[2];
  if (majorText === undefined || minorText === undefined) return null;
  const major = Number(majorText);
  const minor = Number(minorText);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return [major, minor];
}

function isLegacyInstallName(name: string): boolean {
  const version = releaseVersion(name);
  if (!version) return false;
  return (
    version[0] < LEGACY_MAX_MAJOR ||
    (version[0] === LEGACY_MAX_MAJOR && version[1] <= LEGACY_MAX_MINOR)
  );
}

export function isManagedGeName(name: string): boolean {
  if (!MANAGED_GE_NAME_RE.test(name)) return false;
  return name.endsWith("-x86_64") || name.endsWith("-aarch64") || isLegacyInstallName(name);
}

function isExactAssetUrl(url: string, tag: string, assetName: string): boolean {
  if (url.includes("%")) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "github.com" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.pathname === `/GloriousEggroll/proton-ge-custom/releases/download/${tag}/${assetName}`
  );
}

function isAllowedTarballName(tag: string, assetName: string, targetArch: TargetArch): boolean {
  const current = `${tag}-${targetArch}.tar.gz`;
  if (assetName === current) return true;
  return targetArch === "x86_64" && isLegacyInstallName(tag) && assetName === `${tag}.tar.gz`;
}

export function parseReleases(json: string, targetArch: TargetArch): GeRelease[] {
  const raw = JSON.parse(json);
  if (!Array.isArray(raw)) return [];
  const out: GeRelease[] = [];
  for (const r of raw as RawRelease[]) {
    const tag = str(r.tag_name);
    if (!releaseVersion(tag)) continue;
    const assets = Array.isArray(r.assets) ? (r.assets as RawAsset[]) : [];
    const tarballCandidates: GeAsset[] = [];
    for (const a of assets) {
      const name = str(a.name);
      const url = str(a.browser_download_url);
      if (
        !name ||
        !url ||
        !name.endsWith(".tar.gz") ||
        !isAllowedTarballName(tag, name, targetArch) ||
        !isExactAssetUrl(url, tag, name)
      ) {
        continue;
      }
      tarballCandidates.push({ name, url, size: typeof a.size === "number" ? a.size : 0 });
    }

    const selectedTarball = tarballCandidates[0];
    if (!selectedTarball) continue;

    const installName = selectedTarball.name.replace(/\.tar\.gz$/, "");
    const checksumAssetName = `${installName}.sha512sum`;
    const checksumAsset = assets.find((asset) => str(asset.name) === checksumAssetName);
    if (
      checksumAsset &&
      !isExactAssetUrl(str(checksumAsset.browser_download_url), tag, checksumAssetName)
    ) {
      continue;
    }
    const sha512Url = checksumAsset ? str(checksumAsset.browser_download_url) : null;
    const body = str(r.body);
    out.push({
      tag,
      name: str(r.name) || tag,
      publishedAt: str(r.published_at),
      notes: body.length > MAX_NOTES ? `${body.slice(0, MAX_NOTES).trimEnd()}…` : body,
      installName,
      tarball: selectedTarball,
      sha512Url,
    });
  }
  return out;
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
  let cached: CacheEntry | null = null;
  try {
    const raw = await cache.get(cacheKey);
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
          cacheKey,
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
    const releases = parseReleases(res.text, targetArch);
    try {
      await cache.set(
        cacheKey,
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

export type InstallPhase = "downloading" | "verifying" | "extracting";

interface InstallOpts {
  steamRoot: string;
  release: GeRelease;
  downloadId: string; // korreliert die progress-events
  onPhase?: (phase: InstallPhase) => void;
  /** Backend meldet, dass das exakt abgeleitete SHA-Asset mit HTTP 404 fehlt. */
  onWarning?: () => void;
  /** abbruch-abfrage für das fenster vor dem Rust-Download. */
  isCancelled?: () => boolean;
}

// delegiert an das backend (download → sha512-prüfung → swap-schutz → entpacken).
export async function installRelease(ports: { system: System }, opts: InstallOpts): Promise<void> {
  const { system } = ports;

  // "cancelled" im text ist teil des kontrakts: der aufrufer unterscheidet
  // abbruch von fehler an /cancel/i und zeigt dann keine fehlermeldung.
  const abortIfCancelled = () => {
    if (opts.isCancelled?.()) throw new Error("cancelled");
  };

  abortIfCancelled();
  opts.onPhase?.("downloading");

  const result = await system.installGeProton({
    steamRoot: opts.steamRoot,
    releaseTag: opts.release.tag,
    downloadUrl: opts.release.tarball.url,
    downloadId: opts.downloadId,
  });

  if (result === "unverified") {
    opts.onWarning?.();
  }
}
