export interface MeasurementInput {
  medianMs: number;
  baseMs?: number;
  maxThreshold?: number;
  maxRegressionPct?: number;
  calibrationFactor?: number;
  foreignHardwareFactor?: number;
  maxRegressionPctForeign?: number;
}

export interface MeasurementResult {
  ok: boolean;
  allowed?: number;
  tolerancePct?: number;
  reason?: string;
}

export function evaluateMeasurement(input: MeasurementInput): MeasurementResult;
