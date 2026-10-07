// Datum- und zeitdarstellung an einer stelle: die ansichten formatierten
// jeweils direkt über Intl bzw. mit einem eigenen de-DE/en-GB-mapping.
// Außer shortDate bekommt Intl bewusst das reine sprach-tag („de"/„en"):
// „en-GB" würde die protokoll- und stand-ausgaben von 12-h auf 24-h und von
// monat/tag/jahr auf tag/monat/jahr umstellen.

import { getLocale, t } from "./i18n";

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
  return new Date(ms).toLocaleString(getLocale());
}

/** Uhrzeit der aktiven sprache (zeitspalte des protokolls). */
export function timeText(ms: number): string {
  return new Date(ms).toLocaleTimeString(getLocale());
}

/** Relative angabe für frische zeitstempel (proton-manager). Unter 60 sekunden
 *  bleibt der feste sonderfall: Intl würde dort sekunden zählen. `always`
 *  statt `auto`: die tage sind gerundete 24-h-blöcke, „gestern" wäre nach
 *  ~30 h kalendarisch oft falsch. */
export function relativeTime(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return t("time.justNow");
  const minutes = Math.round(seconds / 60);
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: "always" });
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}
