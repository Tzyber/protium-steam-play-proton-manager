// Datum- und zeitdarstellung an einer stelle: die ansichten formatierten
// jeweils direkt über Intl bzw. mit einem eigenen de-DE/en-GB-mapping. Die
// angezeigten formate bleiben unverändert.

import { getLocale, t } from "./i18n";

/** BCP-47-Tag der aktiven sprache für Intl. Bewusst das reine sprach-tag
 *  („de"/„en"): „en-GB" würde die protokoll- und stand-ausgaben von 12-h auf
 *  24-h und von monat/tag/jahr auf tag/monat/jahr umstellen. */
export function localeTag(): string {
  return getLocale();
}

/** Kurzdatum mit zweistelligem jahr (papierkorb-spalte). Tag zuerst, auch im
 *  englischen: die spalte hat flexible breite und darf die reihenfolge nicht
 *  wechseln. */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(getLocale() === "de" ? "de-DE" : "en-GB", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  });
}

/** Datum und uhrzeit der aktiven sprache (stände der history-ansicht). */
export function dateTimeText(ms: number): string {
  return new Date(ms).toLocaleString(localeTag());
}

/** Uhrzeit der aktiven sprache (zeitspalte des protokolls). */
export function timeText(ms: number): string {
  return new Date(ms).toLocaleTimeString(localeTag());
}

/** Relative angabe für frische zeitstempel (proton-manager). */
export function relativeTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t("time.justNow");
  const m = Math.round(s / 60);
  if (m < 60) return t("time.minutesAgo", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("time.hoursAgo", { n: h });
  return t("time.daysAgo", { n: Math.round(h / 24) });
}
