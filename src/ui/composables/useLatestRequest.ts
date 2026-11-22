// Ein Auftrag (Save, Messung, Kopie) darf nur sein eigenes Ergebnis eintragen:
// eine verspätete Antwort aus einem früheren Auftrag oder von einem anderen
// Spiel darf keinen Status setzen. Vier Stellen im Drawer brauchten dieselbe
// Mechanik aus Request-Id, App-Id und einem Wert-Vergleich; hier steht sie
// einmal. Die Id ist nach außen undurchsichtig, damit kein Aufrufer die
// Bestandteile selbst vergleicht.

import type { Game } from "../../core/types";
import { latest } from "../latest";

interface RequestToken {
  readonly isCurrent: () => boolean;
  readonly appId: number | undefined;
}

export function useLatestRequest(getGame: () => Game | null) {
  const guard = latest();

  /** Startet einen neuen Auftrag und macht alle älteren ungültig. */
  function begin(): RequestToken {
    return { isCurrent: guard.begin(), appId: getGame()?.appId };
  }

  /** Macht laufende Aufträge ungültig (z. B. beim Wechsel des Spiels). */
  function invalidate(): void {
    guard.cancel();
  }

  /** true, wenn der Auftrag noch der aktuelle für dasselbe Spiel ist. */
  function matches(token: RequestToken): boolean {
    return token.isCurrent() && getGame()?.appId === token.appId;
  }

  /** Wie `matches`, zusätzlich muss der gesendete Wert noch dem aktuellen
   *  Stand entsprechen (sonst bediente die Antwort einen überholten Entwurf). */
  function matchesValue(token: RequestToken, sameValue: () => boolean): boolean {
    return matches(token) && sameValue();
  }

  return { begin, invalidate, matches, matchesValue };
}
