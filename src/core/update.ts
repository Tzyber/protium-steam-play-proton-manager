import type { Http } from "./ports.js";

export type UpdateHttp = Pick<Http, "get">;

export const UPDATE_RELEASE_URL =
  "https://github.com/Tzyber/protium-steam-play-proton-manager/releases";

const LATEST_RELEASE_URL =
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
  for (let index = 0; index < candidate.length; index += 1) {
    const candidatePart = candidate[index];
    const currentPart = current[index];
    if (candidatePart === undefined || currentPart === undefined) return false;
    if (candidatePart !== currentPart) return candidatePart > currentPart;
  }
  return false;
}

function latestStableVersion(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const release = value as Record<string, unknown>;
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== "string"
  ) {
    return null;
  }
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
