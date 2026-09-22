export interface MeasurementInput {
  medianMs: number;
  baseMs?: number;
  maxThreshold?: number;
  maxRegressionPct?: number;
}

export interface MeasurementResult {
  ok: boolean;
  allowed?: number;
  reason?: string;
}

export function evaluateMeasurement(input: MeasurementInput): MeasurementResult;
