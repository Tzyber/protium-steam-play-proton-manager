// Seiteneffektfreie DOM- und Mount-Helfer für UI-Tests.
// Enthält bewusst keine Mocks oder Adapter-Imports, damit beliebige Testsuiten
// sie vor oder nach vi.mock-Preambles laden können.
import { DOMWrapper, type mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";

/** Pflicht-Element aus dem DOM: ein fehlendes Element lässt den Test mit
 *  klarer Meldung scheitern statt still zurückzuspringen. */
export function requireElement(selector: string, root: ParentNode = document): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`element nicht gefunden: ${selector}`);
  return element;
}

// Der Drawer rendert per `<Teleport to="body">`, deshalb greift VTU
// `wrapper.find(...)` sonst nur in den leeren Kommentarknoten.
export function routeQueriesToBody(wrapper: VueWrapper): void {
  for (const method of ["find", "get", "findAll", "text"] as const) {
    Reflect.set(wrapper, method, (...args: unknown[]) => {
      const dom = new DOMWrapper(document.body);
      const target = dom[method] as (...innerArgs: unknown[]) => unknown;
      return target.apply(dom, args);
    });
  }
}

export function tabEvent(shiftKey = false, bubbles = false): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles, cancelable: true });
}

export async function settleView(): Promise<void> {
  await nextTick();
  await nextTick();
  await Promise.resolve();
}

export function pressedRows(wrapper: ReturnType<typeof mount>, panel: string): boolean[] {
  return wrapper.findAll(`${panel} .row`).map((row) => row.attributes("aria-pressed") === "true");
}

export function buttonWithText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll("button").find((button) => button.text() === text);
}
