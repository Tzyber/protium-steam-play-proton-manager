// GE-Namensregeln, aus `geproton.ts` herausgelöst (R-12): welche namen als
// verwaltete GE-Proton-installationen gelten.

export const MANAGED_GE_NAME_RE = /^GE-Proton[0-9]+-[0-9]+(-(x86_64|aarch64))?$/;

// upstream-snapshot 2026-08-20: suffix-assets ab GE-Proton11-4;
// unsuffixt ist nur die belegte x86_64-legacy-familie bis 11-3.
// export nur für den spiegel-test (tests/security/mirrored-constants.test.ts; Q-01).
export const LEGACY_MAX_MAJOR = 11;
export const LEGACY_MAX_MINOR = 3;

export function releaseVersion(name: string): [number, number] | null {
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

export function isLegacyInstallName(name: string): boolean {
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
