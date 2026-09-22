/**
 * Schwellenlogik des Bench-Gates, getrennt vom Skript, damit sie prüfbar ist.
 * Beide Schwellen gelten: die relative Regression zur Baseline UND die
 * absolute Obergrenze. Vorher war die absolute Schwelle wirkungslos, sobald
 * ein Baseline-Wert existierte.
 */
export function evaluateMeasurement({
  medianMs,
  baseMs,
  maxThreshold,
  maxRegressionPct,
  calibrationFactor = 1,
}) {
  // Die Baseline wurde auf einer konkreten Maschine gemessen. Der
  // Kalibrierwert aus demselben Lauf skaliert sie auf die aktuelle Maschine,
  // sonst waere das Gate an die Hardware des Entwicklungsrechners gebunden
  // (gemessen: der CI-Runner ist rund dreimal langsamer).
  const factor = Number.isFinite(calibrationFactor) && calibrationFactor > 0 ? calibrationFactor : 1;
  const scaledBase = typeof baseMs === "number" ? baseMs * factor : undefined;
  const scaledThreshold = typeof maxThreshold === "number" ? maxThreshold * factor : undefined;
  const relativeLimit =
    scaledBase !== undefined && typeof maxRegressionPct === "number"
      ? scaledBase * (1 + maxRegressionPct / 100)
      : undefined;
  const limits = [relativeLimit, scaledThreshold].filter((value) => typeof value === "number");
  if (limits.length === 0) {
    return { ok: false, allowed: undefined, reason: "keine Schwelle definiert" };
  }
  const allowed = Math.min(...limits);
  if (medianMs <= allowed) return { ok: true, allowed, reason: undefined };

  const broken = [];
  if (relativeLimit !== undefined && medianMs > relativeLimit) {
    broken.push(
      `Baseline ${scaledBase.toFixed(1)} ms (kalibriert, Faktor ${factor.toFixed(2)}) plus ${maxRegressionPct} Prozent = ${relativeLimit.toFixed(1)} ms`,
    );
  }
  if (scaledThreshold !== undefined && medianMs > scaledThreshold) {
    broken.push(`absolute Obergrenze ${scaledThreshold.toFixed(1)} ms (kalibriert)`);
  }
  return { ok: false, allowed, reason: broken.join(" und ") };
}
