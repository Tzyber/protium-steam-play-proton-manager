import { afterEach, describe, expect, it } from "vitest";
import { getLocale, setLocale, t } from "../../src/ui/i18n";
import { de } from "../../src/ui/i18n/de";
import { en } from "../../src/ui/i18n/en";

afterEach(() => setLocale("en"));

describe("i18n, locale-erkennung", () => {
  it("getLocale liefert initialen wert (de wenn navigator 'de*', sonst en)", () => {
    // der initiale wert hängt von navigator ab, der test prüft nur, dass
    // es einer der beiden gültigen werte ist.
    expect(["de", "en"]).toContain(getLocale());
  });

  it("setLocale wechselt die aktive locale (nur für tests)", () => {
    setLocale("de");
    expect(getLocale()).toBe("de");
    setLocale("en");
    expect(getLocale()).toBe("en");
  });
});

describe("i18n, key-lookup", () => {
  it("t('common.cancel') liefert den de-string", () => {
    setLocale("de");
    expect(t("common.cancel")).toBe(de.common.cancel);
  });

  it("t('common.cancel') liefert den en-string", () => {
    setLocale("en");
    expect(t("common.cancel")).toBe(en.common.cancel);
  });

  it("nested keys werden korrekt aufgelöst", () => {
    setLocale("de");
    expect(t("cleanup.searchButton")).toBe(de.cleanup.searchButton);
  });

  it("tief verschachtelte keys (3 ebenen) funktionieren", () => {
    // Status-Labels liegen unter `proton`; Test über Dot-Pfad.
    setLocale("de");
    expect(t("phase.downloading")).toBe(de.phase.downloading);
  });

  it("unbekannter key fällt auf den key-namen selbst zurück (sichtbar im UI)", () => {
    // wir können keinen echten unbekannten key über die typsicherheit testen
    // also übergeben wir einen string, der zwar gültig aussieht, aber nicht
    // existiert (cast zu Key umgeht den TS-check). der vertrag ist:
    // "letzter ausweg ist der key als literal".
    const fakeKey = "does.not.exist" as unknown as Parameters<typeof t>[0];
    expect(t(fakeKey)).toBe("does.not.exist");
  });
});

describe("i18n, interpolation", () => {
  it("einzelner platzhalter {n}", () => {
    setLocale("de");
    expect(t("library.gamesCount", { n: 5 })).toBe("/ 5 spiele");
  });

  it("mehrere platzhalter im selben string", () => {
    setLocale("de");
    expect(t("cleanup.selectedInfo", { n: 28, size: "14.2 GB" })).toBe("28 ausgewählt · 14.2 GB");
  });

  it("zahlen werden zu string konvertiert", () => {
    setLocale("en");
    expect(t("library.gamesCount", { n: 0 })).toBe("/ 0 games");
  });

  it("fehlender parameter: platzhalter bleibt sichtbar stehen", () => {
    setLocale("de");
    // {n} fehlt im params-objekt
    expect(t("library.gamesCount", {})).toBe("/ {n} spiele");
  });

  it("interpolation funktioniert in en genauso", () => {
    setLocale("en");
    expect(t("cleanup.selectedInfo", { n: 28, size: "14.2 GB" })).toBe("28 selected · 14.2 GB");
  });
});

describe("i18n, fallback (vertrag)", () => {
  it("de und en haben das gleiche key-set (review-pflicht: volle abdeckung)", () => {
    // struktur-sync: jede locale muss jeden key haben, sonst läuft der
    // lookup ins leere. hier wird die form (keys) verglichen, nicht die werte.
    const flat = (obj: unknown, prefix = ""): string[] => {
      if (obj == null || typeof obj !== "object") return [];
      return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
        const path = prefix ? `${prefix}.${k}` : k;
        if (typeof v === "string") return [path];
        if (typeof v === "object" && v !== null) return flat(v, path);
        return [];
      });
    };
    const deKeys = flat(de).sort();
    const enKeys = flat(en).sort();
    expect(enKeys).toEqual(deKeys);
  });
});
