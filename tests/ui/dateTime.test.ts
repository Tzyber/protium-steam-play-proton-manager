import { afterEach, describe, expect, it } from "vitest";
import { dateTimeText, localeTag, relativeTime, shortDate, timeText } from "../../src/ui/dateTime";
import { setLocale, t } from "../../src/ui/i18n";

// fester lokalzeitpunkt am 24. des monats: nur so sind tag/monat-reihenfolge
// und 12-h/24-h unterscheidbar, unabhängig von der zeitzone der maschine.
const fixed = new Date(2026, 0, 24, 14, 30, 5).getTime();

describe("localeTag", () => {
  afterEach(() => setLocale("en"));

  it("liefert das reine sprach-tag statt des regionalen", () => {
    setLocale("de");
    expect(localeTag()).toBe("de");
    setLocale("en");
    expect(localeTag()).toBe("en");
  });
});

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
  afterEach(() => setLocale("en"));

  it("stuft sekunden, minuten, stunden und tage", () => {
    setLocale("de");
    const now = Date.now();
    expect(relativeTime(now - 5_000)).toBe(t("time.justNow"));
    expect(relativeTime(now - 3 * 60_000)).toBe(t("time.minutesAgo", { n: 3 }));
    expect(relativeTime(now - 5 * 3_600_000)).toBe(t("time.hoursAgo", { n: 5 }));
    expect(relativeTime(now - 3 * 86_400_000)).toBe(t("time.daysAgo", { n: 3 }));
  });
});
