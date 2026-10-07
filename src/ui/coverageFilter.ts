import type { ScanWarning } from "../core/types";

export function filterWarningsByType<T extends ScanWarning["type"]>(
  warnings: readonly ScanWarning[],
  type: T | readonly T[],
): Extract<ScanWarning, { type: T }>[] {
  const selected = new Set<string>(typeof type === "string" ? [type] : type);
  return warnings.filter((warning): warning is Extract<ScanWarning, { type: T }> =>
    selected.has(warning.type),
  );
}
