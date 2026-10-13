// Laufzeit-Guards für App-IDs und Rohformen, aus `types.ts` herausgelöst
// (R-11): `types.ts` beschreibt die Domänenformen, die Prüfungen liegen hier.

/** Prüft vor `parseSafeAppId`, ob eine App-ID nur Ziffern enthält. */
export const NUMERIC_RE = /^\d+$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Obergrenze gültiger Steam-App-IDs: u32::MAX. Spiegel zur Rust-Grenze in
 *  `parse_app_id` (scope.rs). Non-Steam-Shortcut-IDs belegen legitim den
 *  Bereich 2^31..2^32−1 (Bit 31 gesetzt) und müssen angeboten werden können. */
export const MAX_APP_ID = 4_294_967_295;

/** Riesige Ziffernfolgen parsen jenseits der JS-Präzision (NAME_MAX erlaubt
 *  254 Ziffern → 1.8e254). solche strings liegen über MAX_APP_ID und werden
 *  schon von der Grenzprüfung abgewiesen; jeder wert ≤ MAX_APP_ID ist ohnehin
 *  ein sicherer Integer, ein eigener `isSafeInteger`-Guard wäre tot (K-14).
 *  null = kein brauchbarer wert. */
export function parseSafeAppId(str: string): number | null {
  if (!NUMERIC_RE.test(str)) return null;
  const appId = Number.parseInt(str, 10);
  if (appId < 1 || appId > MAX_APP_ID) return null;
  return appId;
}

/** appId, die im bericht genannt werden darf; alles andere wird verworfen. */
export function validAppId(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_APP_ID
    ? value
    : null;
}

export function validNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
