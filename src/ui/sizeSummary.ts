import { formatBytes } from "./format";
import { t } from "./i18n";

interface SizeSummary {
  measuredBytes: number;
  unknownCount: number;
}

export function summarizeSizes(entries: readonly { sizeBytes?: number }[]): SizeSummary {
  let measuredBytes = 0;
  let unknownCount = 0;
  for (const entry of entries) {
    if (entry.sizeBytes == null) unknownCount += 1;
    else measuredBytes += entry.sizeBytes;
  }
  return { measuredBytes, unknownCount };
}

/** Größe einer Liste als fertiger text: gemessen, teilweise gemessen oder
 *  "nicht gemessen", wenn kein eintrag eine größe trägt. `format` steuert die
 *  byte-darstellung; voreingestellt ist `formatBytes` (unbekannt = "…"),
 *  `formatKnownBytes` nimmt zusätzlich die belegte Null als "0 B". */
export function formatSizeSummary(
  entries: readonly { sizeBytes?: number }[],
  format: (bytes: number) => string = formatBytes,
): string {
  const summary = summarizeSizes(entries);
  if (summary.unknownCount === 0) return format(summary.measuredBytes);
  if (summary.unknownCount === entries.length) return t("common.notMeasured");
  return t("cleanup.partialSize", { size: format(summary.measuredBytes) });
}

/** Absteigend nach gemessener Größe; unbekannte Werte ans Ende. Für Orphans und
 *  Papierkorb-Einträge dieselbe Regel, deshalb hier statt zweimal in der View. */
export function bySizeDesc<T extends { sizeBytes?: number }>(a: T, b: T): number {
  if (a.sizeBytes == null) return b.sizeBytes == null ? 0 : 1;
  if (b.sizeBytes == null) return -1;
  return b.sizeBytes - a.sizeBytes;
}
