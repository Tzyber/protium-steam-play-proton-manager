import { afterEach, describe, expect, it, vi } from "vitest";
import { dateTimeText, relativeTime, shortDate, timeText } from "../../src/ui/dateTime";
import { setLocale } from "../../src/ui/i18n";

// fester lokalzeitpunkt am 24. des monats: nur so sind tag/monat-reihenfolge
// und 12-h/24-h unterscheidbar, unabhängig von der zeitzone der maschine.
const fixed = new Date(2026, 0, 24, 14, 30, 5).getTime();

describe("Datum- und Zeitformat", () => {
  afterEach(() => setLocale("en"));

  it("stellt kurzdaten tag-zuerst dar, in beiden sprachen", () => {
    setLocale("de");
    expect(shortDate(fixed)).toBe("24.01.26");
    setLocale("en");
    expect(shortDate(fixed)).toBe("24/01/26");
  });

  it("hält datum und uhrzeit textgleich zu Intl mit dem sprach-tag", () => {
    for (const locale of ["de", "en"] as const) {
      setLocale(locale);
      expect(dateTimeText(fixed)).toBe(new Date(fixed).toLocaleString(locale));
      expect(timeText(fixed)).toBe(new Date(fixed).toLocaleTimeString(locale));
    }
  });

  it("behält im englischen die 12-h-form des protokolls", () => {
    setLocale("en");
    expect(dateTimeText(fixed)).toMatch(/[AP]M/);
    setLocale("de");
    expect(dateTimeText(fixed)).not.toMatch(/[AP]M/);
  });
});

describe("relativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
    setLocale("en");
  });

  it.each([
    {
      locale: "de",
      texts: ["gerade eben", "vor 1 Minute", "vor 1 Stunde", "vor 1 Tag", "vor 2 Tagen"],
    },
    { locale: "en", texts: ["just now", "1 minute ago", "1 hour ago", "1 day ago", "2 days ago"] },
  ] as const)(
    "rundet an den einheitengrenzen und zählt tage numerisch ($locale)",
    ({ locale, texts }) => {
      vi.useFakeTimers();
      vi.setSystemTime(fixed);
      setLocale(locale);
      const ago = (ms: number) => relativeTime(fixed - ms);

      expect([
        ago(59_000),
        ago(60_000),
        ago(59.5 * 60_000),
        ago(23.5 * 3_600_000),
        ago(2 * 86_400_000),
      ]).toEqual(texts);
    },
  );
});
