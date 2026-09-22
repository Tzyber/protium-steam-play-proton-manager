import { logDiagnostic } from "../core/adapters/tauri";
import { errText } from "../core/errtext";

/**
 * Diagnose lokal festhalten. Das Protokoll ist der Ort fuer alles, was der
 * Nutzer als Meldung sieht oder sehen sollte; Fehler beim Schreiben duerfen
 * die Anwendung nie blockieren, deshalb wird nur gefeuert und vergessen.
 */
export function logEvent(level: "info" | "warn" | "error", message: string): void {
  try {
    void logDiagnostic(level, message).catch(() => {});
  } catch {
    // Diagnose darf die Anwendung nie stoeren, auch nicht mit Attrappen im Test.
  }
}

/** Wie logEvent, aber mit dem rohen Fehlertext. Das Protokoll ist der rohe,
 *  lokale Diagnosestand: die Verlaufsansicht zeigt es wortgetreu, damit eine
 *  Fehlermeldung nachvollziehbar bleibt. Die uebrige Oberflaeche zeigt
 *  Rohtext nie; das Backend ersetzt im Protokoll Home-Pfade durch `~`. */
export function logError(message: string, e: unknown): void {
  logEvent("error", `${message}: ${errText(e)}`);
}
