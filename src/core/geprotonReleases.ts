// Release-Parsing der GE-GitHub-daten, aus `geproton.ts` herausgelöst (R-12):
// aus der API-antwort entstehen nur releases mit verifizierbarer asset-route.

import { isLegacyInstallName, releaseVersion } from "./geprotonNames.js";
import type { TargetArch } from "./ports.js";

const MAX_NOTES = 280;

interface GeAsset {
  name: string;
  url: string;
  /** größe aus dem GitHub-asset; undefined heißt unbekannt, nie still 0 (K-11,
   *  gleiche regel wie `CompatTool.sizeBytes` in types.ts). */
  size?: number;
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

// export nur für den test (tests/core/geproton.test.ts; K-13).
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
      tarballCandidates.push({ name, url, size: typeof a.size === "number" ? a.size : undefined });
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
