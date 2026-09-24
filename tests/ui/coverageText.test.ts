import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScanWarning, SkipReason } from "../../src/core/types.js";
import {
  formatConfigStatus,
  formatLibraryReason,
  formatWarning,
} from "../../src/ui/coverageText.js";
import { setLocale, t } from "../../src/ui/i18n/index.js";

afterEach(() => setLocale("en"));

const SKIP_REASONS: SkipReason[] = ["path-missing", "scope-failed", "read-failed", "unverified"];

// Sentinel statt eines i18n-keys: `library.coverageUnknownWarning` war ein toter
// key und wurde entfernt (U-07). Kein grund darf auf einen sammeltext fallen.
const UNKNOWN_SCAN_FACT = { de: "unbekannter scan-fakt", en: "unknown scan fact" } as const;

// jeder grund einer gattung braucht einen eigenen text: fällt einer auf den
// sammel-fallback zurück, ist die coverage-zeile für den nutzer wertlos.
// Beide sprachen laufen mit: der alte switch in `LibraryView.vue` hatte den
// `unverified`-grund vergessen und lieferte deshalb den sammel-fallback.
describe.each(["de", "en"] as const)("coverageText, warnungsgründe (%s)", (locale) => {
  beforeEach(() => setLocale(locale));

  it("übersetzt jeden library-grund statt auf den fallback zu fallen", () => {
    const texts = SKIP_REASONS.map((reason) => {
      const warning: ScanWarning = { type: "library", path: "/lib", reason };
      const text = formatWarning(warning);
      expect(text).not.toBe(UNKNOWN_SCAN_FACT[locale]);
      expect(text).toContain("/lib");
      return text;
    });
    expect(new Set(texts).size).toBe(SKIP_REASONS.length);
    for (const reason of SKIP_REASONS) {
      expect(formatLibraryReason(reason)).toBe(t(formatLibraryReasonKey(reason)));
    }
  });

  it.each([
    "invalid-filename",
    "unreadable",
    "invalid-content",
    "appid-mismatch",
    "duplicate",
    "name-heuristic",
  ] as const)("übersetzt manifest-grund %s", (reason) => {
    const text = formatWarning({
      type: "manifest",
      library: "/lib",
      manifestName: "appmanifest_620.acf",
      reason,
    });
    expect(text).not.toBe(UNKNOWN_SCAN_FACT[locale]);
    expect(text).toContain("appmanifest_620.acf");
  });

  it.each([
    "path-identity",
    "directory-unreadable",
    "symlink",
    "vdf-unreadable",
    "vdf-invalid",
    "size-unreadable",
  ] as const)("übersetzt compat-tool-grund %s", (reason) => {
    const text = formatWarning({
      type: "compat-tool",
      directory: "/steam/compatibilitytools.d",
      toolName: "GE-Proton9-27",
      reason,
    });
    expect(text).not.toBe(UNKNOWN_SCAN_FACT[locale]);
    expect(text).toContain("GE-Proton9-27");
  });

  it.each(["missing", "unreadable"] as const)("übersetzt compat-config-grund %s", (reason) => {
    const text = formatWarning({ type: "compat-config", reason, detail: "blocked-location" });
    expect(text).not.toBe(UNKNOWN_SCAN_FACT[locale]);
    // V1: nur ein bekannter code wird übersetzt angehängt
    expect(text).toContain(t("errors.codes.blockedLocation"));
  });

  it("hängt einen unbekannten rohtext nicht an die coverage-zeile", () => {
    const text = formatWarning({
      type: "compat-config",
      reason: "unreadable",
      detail: "cannot read /home/nutzer/Steam/config.vdf: Permission denied",
    });
    expect(text).not.toContain("Permission");
    expect(text).not.toContain("/home/nutzer");
    expect(text).toBe(
      t("library.coverageWarningConfig", {
        source: t("library.coverageCompatConfig"),
        reason: t("library.coverageReasonUnreadable"),
      }),
    );
  });

  it.each(["missing", "unreadable", "selection-ambiguous"] as const)(
    "übersetzt launch-config-grund %s",
    (reason) => {
      const text = formatWarning({
        type: "launch-config",
        reason,
        steamUserId: "12345",
        detail: "steam-running",
      });
      expect(text).not.toBe(UNKNOWN_SCAN_FACT[locale]);
      // kontonummer und übersetztes detail werden in einer zeile verbunden
      expect(text).toContain("12345");
      expect(text).toContain(t("errors.codes.steamRunning"));
    },
  );

  it("lässt die kontoklammer weg, wenn kein konto bekannt ist", () => {
    const text = formatWarning({ type: "launch-config", reason: "missing" });
    expect(text).not.toContain("12345");
    expect(text).not.toBe(UNKNOWN_SCAN_FACT[locale]);
  });

  it.each(["available", "missing", "unreadable", "ambiguous"] as const)(
    "übersetzt config-status %s",
    (status) => {
      expect(formatConfigStatus(status)).not.toBe("");
    },
  );
});

function formatLibraryReasonKey(reason: SkipReason) {
  switch (reason) {
    case "path-missing":
      return "library.coverageReasonPathMissing" as const;
    case "scope-failed":
      return "library.coverageReasonScopeFailed" as const;
    case "read-failed":
      return "library.coverageReasonReadFailed" as const;
    case "unverified":
      return "library.coverageReasonUnverified" as const;
  }
}
