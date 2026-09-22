import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Capability {
  permissions: (
    | string
    | {
        identifier: string;
        allow?: { url?: string; path?: string }[];
      }
  )[];
}

const capability = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../src-tauri/capabilities/default.json"), "utf8"),
) as Capability;

/** Die exakte Liste ist der Vertrag: ein Test, der nur nach Teilstrings sucht,
 *  besteht auch dann, wenn die echte Regel weiter gefasst ist (z. B. auf
 *  `https://api.github.com/**` oder den ganzen Host). */
function urlAllowList(): string[] {
  const entry = capability.permissions.find(
    (permission) => typeof permission !== "string" && permission.identifier === "http:default",
  );
  if (typeof entry === "string" || entry === undefined) {
    throw new Error("http:default fehlt in der capability");
  }
  return (entry.allow ?? []).map((rule) => rule.url ?? "");
}

describe("github http capability", () => {
  it("erlaubt genau die drei freigegebenen URLs", () => {
    expect(urlAllowList()).toEqual([
      "https://www.protondb.com/*",
      "https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=15",
      "https://api.github.com/repos/Tzyber/protium-steam-play-proton-manager/releases/latest",
    ]);
  });

  it("enthält keine wildcard- oder hostweite github-freigabe", () => {
    for (const url of urlAllowList()) {
      if (!url.includes("api.github.com")) continue;
      expect(url).not.toMatch(/\*$/);
      expect(url).toMatch(
        /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases(\/[^/]+|\?[^/]*)$/,
      );
    }
  });
});
