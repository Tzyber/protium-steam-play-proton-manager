// N5a/5.15: ein Struktur-Guard für alle wire-arrays. Die Fälle halten fest,
// dass `requireArrayOf` fail-closed ablehnt statt fremde Elemente zu filtern —
// ein gefilterter Vertrag sähe für den Aufrufer wie ein gültiger aus.

import { describe, expect, it } from "vitest";
import {
  isString,
  isValidAppId,
  MAX_APP_ID,
  requireArrayOf,
  validAppId,
} from "../../src/core/guards.js";

describe("requireArrayOf", () => {
  it("liefert die Elemente, wenn alle das Prädikat erfüllen", () => {
    expect(requireArrayOf(["/lib/a", "/lib/b"], isString)).toEqual(["/lib/a", "/lib/b"]);
    expect(requireArrayOf([1, MAX_APP_ID], isValidAppId)).toEqual([1, MAX_APP_ID]);
  });

  it("akzeptiert ein leeres Array", () => {
    expect(requireArrayOf([], isString)).toEqual([]);
  });

  it.each([
    ["string", "/lib/a"],
    ["zahl", 42],
    ["null", null],
    ["undefined", undefined],
    ["objekt", { 0: "/lib/a" }],
  ])("lehnt %s als ganzes ab", (_fall, raw) => {
    expect(requireArrayOf(raw, isString)).toBeNull();
  });

  it("lehnt ein Array mit fremden Elementen ab, statt sie zu filtern", () => {
    expect(requireArrayOf(["/lib/a", 42], isString)).toBeNull();
    expect(requireArrayOf(["/lib/a", null], isString)).toBeNull();
  });

  it("trennt die Verträge: Strings sind keine App-IDs und umgekehrt", () => {
    expect(requireArrayOf(["1628350"], isValidAppId)).toBeNull();
    expect(requireArrayOf([1628350], isString)).toBeNull();
  });

  it.each([
    ["0", 0],
    ["obergrenze + 1", MAX_APP_ID + 1],
    ["nicht ganze zahl", 1.5],
    ["NaN", Number.NaN],
    ["negativ", -1],
  ])("lehnt %s als App-ID ab", (_fall, raw) => {
    expect(requireArrayOf([raw], isValidAppId)).toBeNull();
  });
});

describe("isValidAppId", () => {
  it.each([
    ["1", 1],
    ["obergrenze", MAX_APP_ID],
    ["0", 0],
    ["obergrenze + 1", MAX_APP_ID + 1],
    ["nicht ganze zahl", 1.5],
    ["string", "1"],
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
  ])("stimmt für %s mit validAppId überein", (_fall, raw) => {
    expect(isValidAppId(raw)).toBe(validAppId(raw) !== null);
  });
});

describe("isString", () => {
  it.each([
    ["string", "x", true],
    ["leerer string", "", true],
    ["zahl", 42, false],
    ["null", null, false],
    ["objekt", {}, false],
    ["array", ["x"], false],
  ])("%s ergibt %s", (_fall, raw, expected) => {
    expect(isString(raw)).toBe(expected);
  });
});
