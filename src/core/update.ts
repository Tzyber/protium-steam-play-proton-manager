import type { Http } from "./ports.js";
import { isRecord } from "./types.js";

/** aufrufer-/test-typ von `checkForUpdate` (nur `get`); kein produktiver
 *  fremdimport (K-13). */
export type UpdateHttp = Pick<Http, "get">;

export const UPDATE_RELEASE_URL =
  "https://github.com/Tzyber/protium-steam-play-proton-manager/releases";

// export nur für den spiegel-test (tests/security/github-capability.test.ts; Q-02)
export const LATEST_RELEASE_URL =
  "https://api.github.com/repos/Tzyber/protium-steam-play-proton-manager/releases/latest";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value: string): [number, number, number] | null {
  const match = STABLE_VERSION.exec(value);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && Number.isSafeInteger(patch)
    ? [major, minor, patch]
    : null;
}

function isHigher(candidate: [number, number, number], current: [number, number, number]): boolean {
  // feste tupellänge: positionale destrukturierung kennt keine lücken, ein
  // undefined-guard wäre tot (K-14).
  const [candidateMajor, candidateMinor, candidatePatch] = candidate;
  const [currentMajor, currentMinor, currentPatch] = current;
  if (candidateMajor !== currentMajor) return candidateMajor > currentMajor;
  if (candidateMinor !== currentMinor) return candidateMinor > currentMinor;
  return candidatePatch > currentPatch;
}

function latestStableVersion(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const release = value;
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== "string"
  ) {
    return null;
  }
  // policy: die releases dieses repos tragen ein "v"-präfix; ein tag ohne
  // präfix ist kein release-stand für den versionsvergleich und wird verworfen (K-14).
  const version = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : "";
  return parseVersion(version) ? version : null;
}

/** Prüft nur beim Start. Fehler bleiben lokal folgenlos; Protium braucht online nicht zu sein. */
export async function checkForUpdate(
  http: UpdateHttp,
  currentVersion: string,
): Promise<string | null> {
  const current = parseVersion(currentVersion);
  if (!current) return null;
  try {
    const response = await http.get(LATEST_RELEASE_URL, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) return null;
    const version = latestStableVersion(JSON.parse(response.text));
    const candidate = version ? parseVersion(version) : null;
    return candidate && isHigher(candidate, current) ? version : null;
  } catch {
    return null;
  }
}
