// @vitest-environment happy-dom
import * as fs from "node:fs";
import * as path from "node:path";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { focusFirstFocusable, restoreFocus, trapFocus } from "../../src/ui/a11y";
import BlockedExplanation from "../../src/ui/components/BlockedExplanation.vue";
import ConfirmDialog from "../../src/ui/components/ConfirmDialog.vue";

function tabEvent(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
}

/** dialog-ähnliche struktur: zwei buttons + ein input im root. */
function buildDialog(): {
  root: HTMLElement;
  first: HTMLButtonElement;
  input: HTMLInputElement;
  last: HTMLButtonElement;
} {
  const root = document.createElement("div");
  const first = document.createElement("button");
  first.textContent = "first";
  const input = document.createElement("input");
  const last = document.createElement("button");
  last.textContent = "last";
  root.append(first, input, last);
  document.body.appendChild(root);
  return { root, first, input, last };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("focusFirstFocusable", () => {
  it("fokussiert das erste fokussierbare element", () => {
    const { root, first } = buildDialog();
    expect(focusFirstFocusable(root)).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("überspringt disabled, aria-hidden und tabindex=-1", () => {
    const root = document.createElement("div");
    const disabled = document.createElement("button");
    disabled.disabled = true;
    const hidden = document.createElement("button");
    hidden.setAttribute("aria-hidden", "true");
    const skipped = document.createElement("button");
    skipped.tabIndex = -1;
    const real = document.createElement("button");
    root.append(disabled, hidden, skipped, real);
    document.body.appendChild(root);

    focusFirstFocusable(root);
    expect(document.activeElement).toBe(real);
  });

  it("ohne fokussierbare elemente fällt es auf den root zurück", () => {
    const root = document.createElement("div");
    root.tabIndex = -1;
    root.textContent = "nur text";
    document.body.appendChild(root);

    expect(focusFirstFocusable(root)).toBe(true);
    expect(document.activeElement).toBe(root);
  });

  it("null-root → false, kein crash", () => {
    expect(focusFirstFocusable(null)).toBe(false);
  });
});

describe("trapFocus", () => {
  it("ignoriert andere tasten als Tab", () => {
    const { root, first } = buildDialog();
    first.focus();
    const e = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  it("Tab auf dem letzten element springt zum ersten", () => {
    const { root, first, last } = buildDialog();
    last.focus();
    const e = tabEvent();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("Shift+Tab auf dem ersten element springt zum letzten", () => {
    const { root, first, last } = buildDialog();
    first.focus();
    const e = tabEvent(true);
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("Tab in der mitte läuft normal weiter (kein eingriff)", () => {
    const { root, first } = buildDialog();
    first.focus();
    const e = tabEvent();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(false);
  });

  it("fokus außerhalb des roots wird wieder hereingeholt", () => {
    const { root, first } = buildDialog();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const e = tabEvent();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("leerer root: Tab wird abgefangen, root bekommt den fokus", () => {
    const root = document.createElement("div");
    root.tabIndex = -1;
    document.body.appendChild(root);

    const e = tabEvent();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(root);
  });

  it("null-root: kein eingriff", () => {
    const e = tabEvent();
    trapFocus(e, null);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("restoreFocus", () => {
  it("fokussiert das gespeicherte element, wenn es noch im DOM ist", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    restoreFocus(btn);
    expect(document.activeElement).toBe(btn);
  });

  it("fallback-kette bei entferntem element: [aria-current=page] zuerst", () => {
    const ghost = document.createElement("button");
    document.body.appendChild(ghost);
    ghost.remove(); // disconnected

    const nav = document.createElement("button");
    nav.setAttribute("aria-current", "page");
    document.body.appendChild(nav);
    const h1 = document.createElement("h1");
    h1.tabIndex = -1;
    const content = document.createElement("div");
    content.className = "content";
    content.appendChild(h1);
    document.body.appendChild(content);

    restoreFocus(ghost);
    expect(document.activeElement).toBe(nav);
  });

  it("fallback ohne nav: .content h1", () => {
    const h1 = document.createElement("h1");
    h1.tabIndex = -1;
    const content = document.createElement("div");
    content.className = "content";
    content.appendChild(h1);
    document.body.appendChild(content);

    restoreFocus(null);
    expect(document.activeElement).toBe(h1);
  });

  it("letzter fallback: body", () => {
    restoreFocus(null);
    expect(document.activeElement).toBe(document.body);
  });
});

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const part = channel / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const tokens = new Map<string, string>();
for (const match of fs
  .readFileSync(path.resolve(__dirname, "../../src/ui/tokens.css"), "utf-8")
  .matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
  if (match[1] && match[2]) tokens.set(match[1], match[2]);
}

describe("a11y Gate: berechneter Kontrast aus den Tokens", () => {
  it("primaerer und sekundaerer Text erfuellen WCAG AA auf ihrem Untergrund", () => {
    const pairs: Array<[string, string, number]> = [
      ["--fg-0", "--bg-0", 4.5],
      ["--fg-0", "--bg-1", 4.5],
      ["--fg-1", "--bg-1", 4.5],
      ["--fg-1", "--bg-2", 4.5],
    ];
    for (const [fg, bg, minimum] of pairs) {
      const foreground = tokens.get(fg);
      const background = tokens.get(bg);
      expect(foreground, `${fg} fehlt in tokens.css`).toBeDefined();
      expect(background, `${bg} fehlt in tokens.css`).toBeDefined();
      if (foreground === undefined || background === undefined) continue;
      const ratio = contrast(foreground, background);
      expect(ratio, `${fg} auf ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(minimum);
    }
  });

  it("das Signal bleibt als Fokus- und Aktionsfarbe sichtbar", () => {
    const signal = tokens.get("--signal");
    const background = tokens.get("--bg-0");
    expect(signal).toBeDefined();
    expect(background).toBeDefined();
    if (signal === undefined || background === undefined) return;
    expect(contrast(signal, background)).toBeGreaterThanOrEqual(3);
  });
});

describe("a11y Gate: Dialoge und Live-Regionen", () => {
  it("ConfirmDialog implementiert barrierefreie Dialog-Rollen und Labels", () => {
    mount(ConfirmDialog, {
      props: { title: "Test Dialog" },
      slots: { default: "Inhalt" },
    });

    const element = document.body.querySelector(".dialog");
    expect(element).not.toBeNull();
    expect(element?.getAttribute("role")).toBe("dialog");
    expect(element?.getAttribute("aria-modal")).toBe("true");
    expect(element?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(element?.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("BlockedExplanation ist eine Statusmeldung mit Garantiesatz", () => {
    const wrapper = mount(BlockedExplanation, {
      props: { title: "Blockiert", guarantee: "Es wurde nichts veraendert." },
    });

    expect(wrapper.attributes("role")).toBe("status");
    expect(wrapper.text()).toContain("Es wurde nichts veraendert.");
  });
});
