// Der Auftrags-Guard steckte doppelt in HistoryView und hatte keinen direkten
// Test für eine verspätete Antwort. Hier steht die Regel einmal: nur der
// jüngste Lauf schreibt Inhalt, Fehler und Ladezustand.

import { describe, expect, it } from "vitest";
import { isReactive } from "vue";
import { useLatestLoad } from "../../src/ui/composables/useLatestLoad";
import { formatError } from "../../src/ui/formatError";
import { deferred } from "../support/factories";

function take<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}

function loaderFor<T>(empty: T) {
  const gates: ReturnType<typeof deferred<T>>[] = [];
  const latest = useLatestLoad<T>(empty, () => {
    const next = deferred<T>();
    gates.push(next);
    return next.promise;
  });
  return { gates, latest };
}

function loader() {
  return loaderFor("leer");
}

describe("useLatestLoad", () => {
  it("trägt die antwort des laufes ein und beendet den ladezustand", async () => {
    const { gates, latest } = loader();
    const done = latest.load();
    expect(latest.loading.value).toBe(true);
    expect(latest.data.value).toBe("leer");

    take(gates, 0).resolve("neu");
    await done;

    expect(latest.data.value).toBe("neu");
    expect(latest.error.value).toBeNull();
    expect(latest.loading.value).toBe(false);
  });

  it("ein neuer lauf löscht den fehler sofort, den inhalt erst bei der eigenen antwort", async () => {
    const { gates, latest } = loader();
    const first = latest.load();
    take(gates, 0).resolve("alt");
    await first;

    const second = latest.load();
    expect(latest.data.value).toBe("alt");
    expect(latest.loading.value).toBe(true);
    take(gates, 1).reject("unreadable");
    await second;
    expect(latest.data.value).toBe("leer");
    expect(latest.error.value).toBe(formatError("unreadable"));

    const third = latest.load();
    expect(latest.loading.value).toBe(true);
    expect(latest.error.value).toBeNull();
    expect(latest.data.value).toBe("leer");

    take(gates, 2).resolve("neu");
    await third;
    expect(latest.data.value).toBe("neu");
    expect(latest.error.value).toBeNull();
    expect(latest.loading.value).toBe(false);
  });

  it("eine verspätete antwort überschreibt weder inhalt noch ladezustand", async () => {
    const { gates, latest } = loader();
    const older = latest.load();
    const newer = latest.load();
    expect(latest.loading.value).toBe(true);

    take(gates, 0).resolve("alt");
    await older;
    expect(latest.data.value).toBe("leer");
    expect(latest.loading.value).toBe(true);
    expect(latest.error.value).toBeNull();

    take(gates, 1).resolve("neu");
    await newer;
    expect(latest.data.value).toBe("neu");
    expect(latest.loading.value).toBe(false);
  });

  it("eine verspätete fehlantwort lässt den jüngeren erfolg stehen", async () => {
    const { gates, latest } = loader();
    const older = latest.load();
    const newer = latest.load();
    take(gates, 1).resolve("neu");
    await newer;
    take(gates, 0).reject("unreadable");
    await older;

    expect(latest.data.value).toBe("neu");
    expect(latest.error.value).toBeNull();
    expect(latest.loading.value).toBe(false);
  });

  it("ersetzt objekt-payloads ganz und legt sie nicht in einen deep-proxy", async () => {
    interface Payload {
      items: { appId: number }[];
    }
    const first: Payload = { items: [{ appId: 42 }] };
    const second: Payload = { items: [{ appId: 73 }] };
    const { gates, latest } = loaderFor<Payload>({ items: [] });

    const older = latest.load();
    take(gates, 0).resolve(first);
    await older;

    // shallowRef: derselbe objekt-verweis, kein reaktiver proxy. mit ref wäre
    // der wert tief proxied und die identität unten schon verloren.
    expect(isReactive(latest.data.value)).toBe(false);
    expect(latest.data.value).toBe(first);

    const newer = latest.load();
    take(gates, 1).resolve(second);
    await newer;

    expect(isReactive(latest.data.value)).toBe(false);
    expect(latest.data.value).toBe(second);
    expect(latest.data.value.items).toEqual([{ appId: 73 }]);
    // der alte wert bleibt unangetastet: ersetzt, nicht mutiert.
    expect(first.items).toEqual([{ appId: 42 }]);
  });

  it("eine verspätete erfolgsantwort lässt den jüngeren fehler stehen", async () => {
    const { gates, latest } = loader();
    const older = latest.load();
    const newer = latest.load();
    take(gates, 1).reject("unreadable");
    await newer;
    take(gates, 0).resolve("alt");
    await older;

    expect(latest.data.value).toBe("leer");
    expect(latest.error.value).toBe(formatError("unreadable"));
    expect(latest.loading.value).toBe(false);
  });
});
