// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlayButton from "../../src/ui/components/PlayButton.vue";

const mockLaunchGame = vi.hoisted(() => vi.fn(async () => {}));
const mockShowNotification = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/adapters/tauri", () => ({
  launchGame: mockLaunchGame,
}));
vi.mock("../../src/ui/stores/uiStore", () => ({
  useUiStore: vi.fn(() => ({ showNotification: mockShowNotification })),
}));

// i18n: minimale nachbildung, t() bildet key auf label ab.
// params werden angehängt, damit interpolation-argumente (z. b. {error})
// im assert sichtbar bleiben statt zu verschwinden.
vi.mock("../../src/ui/i18n", () => ({
  t: vi.fn((key: string, params?: Record<string, string>) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("PlayButton", () => {
  describe("compact (GameCard)", () => {
    function mountCompact() {
      return mount(PlayButton, {
        props: { appId: 570, name: "Team Fortress 2", variant: "compact" },
      });
    }

    it("rendert button mit aria-label via card.launch", () => {
      const wrapper = mountCompact();
      const btn = wrapper.find("button");
      expect(btn.attributes("aria-label")).toBe(
        `card.launch ${JSON.stringify({ name: "Team Fortress 2" })}`,
      );
    });

    it("hat klasse compact", () => {
      const wrapper = mountCompact();
      expect(wrapper.find("button").classes()).toContain("compact");
    });

    it("kein sichtbarer text (nur icon)", () => {
      const wrapper = mountCompact();
      expect(wrapper.find("button").text()).toBe("");
    });

    it("klick ruft launchGame(570) auf", async () => {
      const wrapper = mountCompact();
      await wrapper.find("button").trigger("click");
      expect(mockLaunchGame).toHaveBeenCalledWith(570);
    });
  });

  describe("full (Drawer)", () => {
    function mountFull() {
      return mount(PlayButton, {
        props: { appId: 730, name: "Counter-Strike 2", variant: "full" },
      });
    }

    it("rendert button mit aria-label via drawer.launch", () => {
      const wrapper = mountFull();
      expect(wrapper.find("button").attributes("aria-label")).toBe(
        `drawer.launch ${JSON.stringify({ name: "Counter-Strike 2" })}`,
      );
    });

    it("hat klasse full", () => {
      const wrapper = mountFull();
      expect(wrapper.find("button").classes()).toContain("full");
    });

    it("zeigt sichtbaren text drawer.play", () => {
      const wrapper = mountFull();
      expect(wrapper.find("button").text()).toContain("drawer.play");
    });

    it("klick ruft launchGame(730) auf", async () => {
      const wrapper = mountFull();
      await wrapper.find("button").trigger("click");
      expect(mockLaunchGame).toHaveBeenCalledWith(730);
    });
  });

  describe("fehlerpfad", () => {
    it("zeigt notification bei launchGame-fehler", async () => {
      mockLaunchGame.mockRejectedValueOnce(new Error("steam not found"));
      const wrapper = mount(PlayButton, {
        props: { appId: 1, name: "x", variant: "compact" },
      });
      await wrapper.find("button").trigger("click");
      // warten auf microtask (catch läuft async)
      await new Promise((r) => setTimeout(r, 0));
      const call = mockShowNotification.mock.calls[0]?.[0] ?? "";
      expect(call).toContain("drawer.launchFailed");
      expect(call).toContain("steam not found");
    });
  });
});
