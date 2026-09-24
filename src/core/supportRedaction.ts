// Redaktionsregeln des Support-Berichts: alles, was einen echten Namen oder
// Pfad durch einen stabilen platzhalter ersetzt. Getrennt von `support.ts`,
// damit die Projektion (Fakten sammeln) und die Schwärzung (Namen ersetzen)
// unabhängig prüfbar bleiben.

import { BLOCKLIST } from "./blocklist.js";
import { MANAGED_GE_NAME_RE } from "./geproton.js";
import { type Game, isCompatToolSentinel, MAX_APP_ID, type ScanResult } from "./types.js";

/** platzhalter für einen compat-tool-namen, der nicht als builtin oder
 *  managed GE-Name belegt ist. */
const TOOL_ALIAS = "<compat-tool-1>";

/** tool-name für den bericht: builtin-label, sonst der name selbst, wenn er
 *  dem managed-GE-muster entspricht, sonst der platzhalter. */
export function projectToolName(name: string): string {
  // proton_11 teilt seinen Namen mit ARM64; der erste Eintrag vermeidet eine Architekturannahme.
  const builtin = BLOCKLIST.find(
    (entry) => entry.category === "proton-builtin" && entry.toolName === name,
  );
  if (builtin) return builtin.label;
  // Nur Syntaxfreigabe, kein Beleg für Herkunft oder Installation.
  return MANAGED_GE_NAME_RE.exec(name)?.[0] === name ? name : TOOL_ALIAS;
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

/** library-pfad → `<steam-library-N>` (index in der scan-liste). */
export function libraryAlias(game: Game, result: ScanResult): string | null {
  if (!Array.isArray(result.libraries) || typeof game.library !== "string") return null;
  const index = result.libraries.indexOf(game.library);
  return index < 0 ? null : `<steam-library-${index + 1}>`;
}

/** echte tool-namen; "default" und "unknown" sind sentinels, keine tools. */
export function isToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !isCompatToolSentinel(value);
}
