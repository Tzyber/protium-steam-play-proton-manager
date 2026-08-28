export interface SizeSummary {
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
