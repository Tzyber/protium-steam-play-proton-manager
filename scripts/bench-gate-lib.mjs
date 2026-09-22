/**
 * Schwellenlogik des Bench-Gates, getrennt vom Skript, damit sie prüfbar ist.
 * Beide Schwellen gelten: die relative Regression zur Baseline UND die
 * absolute Obergrenze. Vorher war die absolute Schwelle wirkungslos, sobald
 * ein Baseline-Wert existierte.
 */
export function evaluateMeasurement({ medianMs, baseMs, maxThreshold, maxRegressionPct }) {
  const relativeLimit =
    typeof baseMs === "number" && typeof maxRegressionPct === "number"
      ? baseMs * (1 + maxRegressionPct / 100)
      : undefined;
  const limits = [relativeLimit, maxThreshold].filter((value) => typeof value === "number");
  if (limits.length === 0) {
    return { ok: false, allowed: undefined, reason: "keine Schwelle definiert" };
  }
  const allowed = Math.min(...limits);
  if (medianMs <= allowed) return { ok: true, allowed, reason: undefined };

  const broken = [];
  if (relativeLimit !== undefined && medianMs > relativeLimit) {
    broken.push(`Baseline ${baseMs} ms plus ${maxRegressionPct} Prozent (${relativeLimit.toFixed(1)} ms)`);
  }
  if (typeof maxThreshold === "number" && medianMs > maxThreshold) {
    broken.push(`absolute Obergrenze ${maxThreshold} ms`);
  }
  return { ok: false, allowed, reason: broken.join(" und ") };
}
