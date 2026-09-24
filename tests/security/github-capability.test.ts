import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASES_URL } from "../../src/core/geproton.js";
import { paths } from "../../src/core/paths.js";
import { PROTONDB_API_BASE } from "../../src/core/protondb.js";
import { LATEST_RELEASE_URL } from "../../src/core/update.js";

interface Capability {
  permissions: (
    | string
    | {
        identifier: string;
        allow?: { url?: string; path?: string }[];
      }
  )[];
}

interface TauriConfig {
  app: { security: { csp: Record<string, string> } };
}

const capability = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../src-tauri/capabilities/default.json"), "utf8"),
) as Capability;

const tauriConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../src-tauri/tauri.conf.json"), "utf8"),
) as TauriConfig;

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

  // Q-02: die Freigaben sind an die TS-URL-konstanten gebunden. Ein Host- oder
  // Pfadwechsel im code ohne Capability-Update fällt hier auf, statt erst als
  // stiller 403 zur laufzeit.
  it("bindet die http-scopes an die TS-URL-konstanten", () => {
    const allow = urlAllowList();
    expect(allow).toContain(RELEASES_URL);
    expect(allow).toContain(LATEST_RELEASE_URL);
    // protondb: die capability deckt denselben host wie die TS-basis ab.
    expect(allow).toContain(`${new URL(PROTONDB_API_BASE).origin}/*`);
  });

  it("bindet die CSP img-src an die Cover-URL", () => {
    const imgSrc = tauriConfig.app.security.csp["img-src"] ?? "";
    const coverOrigin = new URL(paths.headerImageUrl(1)).origin;
    expect(imgSrc).toContain(coverOrigin);
    // der origin muss exakt und ohne wildcard stehen, sonst erlaubt die CSP
    // beliebige hosts und der test verliert seinen wert.
    for (const token of imgSrc.split(/\s+/)) {
      if (!token.startsWith("https://")) continue;
      expect(token).toBe(coverOrigin);
    }
  });
});
