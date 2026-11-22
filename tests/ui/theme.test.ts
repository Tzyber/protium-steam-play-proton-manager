// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readRepoFile, tokenValue } from "../support/themeTokens";

describe("Erster Paint (4.16)", () => {
  it("index.html trägt keine statische Sprache mehr", () => {
    expect(readRepoFile("index.html")).not.toMatch(/<html[^>]*\blang\s*=/i);
  });

  it("der erste-Paint-Hintergrund entspricht --bg-0", () => {
    const background = /background:\s*(#[0-9a-fA-F]{6})/.exec(readRepoFile("index.html"))?.[1];
    expect(tokenValue("--bg-0")).toBeDefined();
    expect(background?.toLowerCase()).toBe(tokenValue("--bg-0")?.toLowerCase());
  });
});
