// T-13: der Drawer rendert per `<Teleport to="body">`. Der SFC-Compiler
// importiert das eingebaute Teleport direkt aus "vue", deshalb greift
// `global.stubs.Teleport` nicht: VTU stubbt nur Komponenten, die der Compiler
// über `resolveComponent` auflöst. Der gerenderte Inhalt liegt also in
// `document.body`, und `wrapper.find(...)` sieht nur den leeren Kommentarknoten
// an der Wurzel. Diese Hilfe richtet die DOM-Abfragen auf das Dokument aus.
import { DOMWrapper, type VueWrapper } from "@vue/test-utils";

export function routeQueriesToBody(wrapper: VueWrapper): void {
  for (const method of ["find", "get", "findAll", "text"] as const) {
    Reflect.set(wrapper, method, (...args: unknown[]) => {
      const dom = new DOMWrapper(document.body);
      const target = dom[method] as (...innerArgs: unknown[]) => unknown;
      return target.apply(dom, args);
    });
  }
}
