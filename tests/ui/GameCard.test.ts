// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Game } from "../../src/core/types";

const coverState = vi.hoisted(() => ({ src: null as string | null }));

vi.mock("../../src/ui/stores/uiStore", () => ({
  useUiStore: () => ({ openGame: vi.fn() }),
}));
vi.mock("../../src/ui/useCover", () => ({
  useCover: () => ({ src: coverState.src, onError: vi.fn() }),
}));
vi.mock("../../src/ui/components/PlayButton.vue", () => ({
  default: {
    template: '<button data-testid="play-button" type="button" aria-label="Spiel starten" />',
  },
}));
vi.mock("../../src/ui/components/TierBadge.vue", () => ({
  default: { template: '<span data-testid="tier-badge">gold</span>' },
}));

import GameCard from "../../src/ui/components/GameCard.vue";

function game(overrides: Partial<Game> = {}): Game {
  return {
    appId: 42,
    name: "Testspiel",
    library: "/games",
    sizeBytes: 0,
    compatTool: "default",
    compatToolSource: "default",
    protonDb: { tier: "gold", confidence: "strong" },
    localHeader: null,
    headerImage: null,
    ...overrides,
  };
}

afterEach(() => {
  coverState.src = null;
});

describe("GameCard zugänglicher Name", () => {
  it("macht das Cover-Bild dekorativ und benennt die Karte genau einmal", () => {
    coverState.src = "blob:cover";
    const wrapper = mount(GameCard, { props: { game: game() } });
    const card = wrapper.get(".card-main");

    expect(card.attributes("aria-label")).toContain("Testspiel");
    expect(card.find("img").attributes("alt")).toBe("");
    expect(card.find(".cover-fallback").exists()).toBe(false);
  });

  it("verhindert einen zweiten Namen im Fallback, ohne Badge oder Startaktion zu verstecken", () => {
    const wrapper = mount(GameCard, { props: { game: game() } });
    const card = wrapper.get(".card-main");

    expect(card.attributes("aria-label")).toContain("Testspiel");
    expect(card.get(".cover-fallback").attributes("aria-hidden")).toBe("true");
    expect(wrapper.get("[data-testid='tier-badge']").attributes("aria-hidden")).toBeUndefined();
    expect(wrapper.get("[data-testid='play-button']").attributes("aria-hidden")).toBeUndefined();
  });
});
