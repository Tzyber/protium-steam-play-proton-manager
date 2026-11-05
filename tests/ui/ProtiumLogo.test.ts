// @vitest-environment happy-dom

import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import ProtiumLogo from "../../src/ui/components/ProtiumLogo.vue";

// happy-dom legt pro matchMedia-aufruf eine neue liste an, ein change-event
// käme nie beim bauteil an. der stub liefert eine geteilte liste, damit der
// reaktionspfad überhaupt beobachtbar ist.
type MatchMediaStub = Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;

let listeners: EventListener[] = [];
let initialMatches = false;
const mounted: VueWrapper[] = [];

// die query ist für den stub irrelevant: alle abfragen laufen auf dieselbe
// geteilte liste. der stub deckt nur die drei member ab, die das bauteil benutzt.
function matchMediaStub(): MatchMediaStub {
  return {
    matches: initialMatches,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === "change" && typeof listener === "function") listeners.push(listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === "change" && typeof listener === "function") {
        listeners = listeners.filter((entry) => entry !== listener);
      }
    },
  };
}

function mountLogo(): VueWrapper {
  const wrapper = mount(ProtiumLogo, { attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

function unmountLogo(wrapper: VueWrapper): void {
  const index = mounted.indexOf(wrapper);
  if (index >= 0) mounted.splice(index, 1);
  wrapper.unmount();
}

function emitReducedMotion(matches: boolean): void {
  const event = new MediaQueryListEvent("change", { matches });
  for (const listener of listeners) listener(event);
}

function animations(): number {
  return document.body.querySelectorAll("animate").length;
}

beforeEach(() => {
  listeners = [];
  initialMatches = false;
  vi.stubGlobal("matchMedia", matchMediaStub);
});

afterEach(() => {
  // kein DOM-abriss unter lebender instanz: erst die bauteile unmounten, dann
  // den globalen stub zurücknehmen.
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe("ProtiumLogo", () => {
  it("animiert ohne reduzierte bewegung und folgt danach der media query", async () => {
    mountLogo();
    expect(animations()).toBeGreaterThan(0);

    emitReducedMotion(true);
    await nextTick();
    expect(animations()).toBe(0);

    emitReducedMotion(false);
    await nextTick();
    expect(animations()).toBeGreaterThan(0);
  });

  it("startet ohne animation, wenn die query bereits reduziert meldet", () => {
    initialMatches = true;
    mountLogo();
    expect(animations()).toBe(0);
  });

  it("meldet den change-handler beim unmount ab", () => {
    const wrapper = mountLogo();
    expect(listeners).toHaveLength(1);

    unmountLogo(wrapper);
    expect(listeners).toHaveLength(0);
  });
});
