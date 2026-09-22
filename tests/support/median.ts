/**
 * Median der Messwerte des Scan-Benchmarks. Getrennt von `scan.bench.ts`,
 * damit die Rechnung ohne den Benchmarklauf prüfbar ist: sie war zuvor für
 * ungerade Stichproben falsch (Mittel der beiden unteren Mittwerte) und ließ
 * das Gate eine Regression bestehen.
 */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const single = sorted[middle];
  if (single === undefined) throw new Error("median requires samples");
  if (sorted.length % 2 === 1) return single;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new Error("median requires samples");
  return (lower + single) / 2;
}
