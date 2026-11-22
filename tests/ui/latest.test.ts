import { describe, expect, it } from "vitest";
import { latest } from "../../src/ui/latest";

describe("latest", () => {
  it("begin liefert einen Check, der für den aktuellen Auftrag true ergibt", () => {
    const guard = latest();
    const isCurrent = guard.begin();
    expect(isCurrent()).toBe(true);
  });

  it("ein neuer begin macht den älteren Check ungültig", () => {
    const guard = latest();
    const first = guard.begin();
    const second = guard.begin();

    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("cancel macht den aktiven Check ungültig", () => {
    const guard = latest();
    const isCurrent = guard.begin();

    guard.cancel();

    expect(isCurrent()).toBe(false);
  });
});
