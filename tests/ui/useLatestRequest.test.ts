// T-04: `useLatestRequest` ist die zentrale Stale-Response-Logik des Drawers
// (Save, Messung, Kopie), hatte aber keinen direkten Test. Diese Datei prüft die
// vier Fälle, die die Mechanik tragen: überholte Antwort, gleicher Wert, Wechsel
// und den Spielwechsel über die appId.

import { describe, expect, it } from "vitest";
import type { Game } from "../../src/core/types";
import { useLatestRequest } from "../../src/ui/useLatestRequest";
import { game as makeGame } from "../support/factories";

function holder(initial: Game | null) {
  let current = initial;
  return {
    get: () => current,
    set: (next: Game | null) => {
      current = next;
    },
  };
}

describe("useLatestRequest", () => {
  it("begin liefert ein token, das direkt zum auftrag passt", () => {
    const latest = useLatestRequest(holder(makeGame({ appId: 42 })).get);
    const token = latest.begin();
    expect(latest.matches(token)).toBe(true);
  });

  it("ein neuer begin macht das ältere token ungültig (überholte antwort)", () => {
    const latest = useLatestRequest(holder(makeGame({ appId: 42 })).get);
    const older = latest.begin();
    const newer = latest.begin();
    // die verspätete antwort gehört nicht mehr hierher, die frische schon
    expect(latest.matches(older)).toBe(false);
    expect(latest.matches(newer)).toBe(true);
  });

  it("invalidate verwirft laufende aufträge (z. b. spielwechsel)", () => {
    const latest = useLatestRequest(holder(makeGame({ appId: 42 })).get);
    const token = latest.begin();
    latest.invalidate();
    expect(latest.matches(token)).toBe(false);
  });

  it("ein wechsel der appId macht das token ungültig", () => {
    const game = holder(makeGame({ appId: 42 }));
    const latest = useLatestRequest(game.get);
    const token = latest.begin();
    game.set(makeGame({ appId: 43 }));
    expect(latest.matches(token)).toBe(false);
  });

  it("matchesValue verlangt zusätzlich den noch aktuellen wert", () => {
    const latest = useLatestRequest(holder(makeGame({ appId: 42 })).get);
    let draft = "a";
    const token = latest.begin();
    expect(latest.matchesValue(token, () => draft === "a")).toBe(true);
    // gleicher auftrag, aber der entwurf wurde weitergetippt: überholter wert
    draft = "ab";
    expect(latest.matchesValue(token, () => draft === "a")).toBe(false);
    expect(latest.matchesValue(token, () => draft === "ab")).toBe(true);
  });

  it("ohne spiel passt das token, bis ein spiel gewählt wird", () => {
    const game = holder(null);
    const latest = useLatestRequest(game.get);
    const token = latest.begin();
    expect(latest.matches(token)).toBe(true);
    game.set(makeGame({ appId: 1 }));
    expect(latest.matches(token)).toBe(false);
    // rückkehr zum gleichen kontext (wieder kein spiel) macht es gültig
    game.set(null);
    expect(latest.matches(token)).toBe(true);
  });
});
