import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASES_URL } from "../../src/core/geproton.js";
import { paths } from "../../src/core/paths.js";
import { PROTONDB_API_BASE } from "../../src/core/protondb.js";
import { LATEST_RELEASE_URL } from "../../src/core/update.js";

interface Capability {
  permissions: (string | { identifier: string })[];
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

const httpGet = readFileSync(
  resolve(import.meta.dirname, "../../src-tauri/src/commands/http_get.rs"),
  "utf8",
);

function rustConst(name: string): string | undefined {
  return httpGet.match(new RegExp(`const ${name}: &str =\\s*"([^"]+)";`))?.[1];
}

// S-02: die webview fetcht nicht mehr selbst. Die Allowlist liegt exakt in
// `http_get.rs` und ist hier an die TS-URL-konstanten gebunden.
describe("http-zugang der webview", () => {
  it("gewährt keine http-permission", () => {
    const identifiers = capability.permissions.map((permission) =>
      typeof permission === "string" ? permission : permission.identifier,
    );
    expect(identifiers.filter((identifier) => identifier.startsWith("http:"))).toEqual([]);
  });

  it("bindet die rust-allowlist an die TS-URL-konstanten", () => {
    expect(rustConst("GE_RELEASES_URL")).toBe(RELEASES_URL);
    expect(rustConst("PROTIUM_LATEST_URL")).toBe(LATEST_RELEASE_URL);
    expect(rustConst("PROTONDB_SUMMARY_PREFIX")).toBe(`${PROTONDB_API_BASE}/`);
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

  // P-02: die vollständige direktivenliste ist der vertrag. Einzelne
  // bindungen (img-src) blieben bestehen, wenn eine andere direktive
  // gelockert würde; dieser golden-test fällt dann auf.
  it("pinnt die vollständige CSP-direktivenliste", () => {
    expect(tauriConfig.app.security.csp).toEqual({
      "default-src": "'self'",
      "base-uri": "'none'",
      "object-src": "'none'",
      "frame-src": "'none'",
      "form-action": "'self'",
      "frame-ancestors": "'self'",
      "img-src": "'self' data: blob: https://cdn.cloudflare.steamstatic.com",
      "connect-src": "'self' ipc: http://ipc.localhost",
      "style-src": "'self' 'unsafe-inline'",
    });
  });
});
