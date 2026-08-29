import { describe, expect, it } from "vitest";
import { checkForUpdate, type UpdateHttp } from "../../src/core/update.js";

function httpResponse(body: unknown, status = 200): UpdateHttp {
  return {
    get: async () => ({
      status,
      ok: status >= 200 && status < 300,
      text: JSON.stringify(body),
      headers: {},
    }),
  };
}

describe("checkForUpdate", () => {
  it("meldet eine höhere veröffentlichte stabile version", async () => {
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v0.6.11", draft: false, prerelease: false }),
        "0.6.10",
      ),
    ).resolves.toBe("0.6.11");
  });

  it("ignoriert gleiche und ältere versionen", async () => {
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v0.6.10", draft: false, prerelease: false }),
        "0.6.10",
      ),
    ).resolves.toBeNull();
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v0.6.9", draft: false, prerelease: false }),
        "0.6.10",
      ),
    ).resolves.toBeNull();
  });

  it("erkennt höhere minor- und major-versionen", async () => {
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v0.7.0", draft: false, prerelease: false }),
        "0.6.10",
      ),
    ).resolves.toBe("0.7.0");
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v1.0.0", draft: false, prerelease: false }),
        "0.6.10",
      ),
    ).resolves.toBe("1.0.0");
  });

  it("ignoriert vorab- und entwurf-releases sowie ungültige versionen", async () => {
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v0.7.0-beta.1", draft: false, prerelease: true }),
        "0.6.10",
      ),
    ).resolves.toBeNull();
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v0.7.0-beta.1", draft: false, prerelease: false }),
        "0.6.10",
      ),
    ).resolves.toBeNull();
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v0.7.0+build.1", draft: false, prerelease: false }),
        "0.6.10",
      ),
    ).resolves.toBeNull();
    await expect(
      checkForUpdate(httpResponse({ tag_name: "v0.7", draft: false, prerelease: false }), "0.6.10"),
    ).resolves.toBeNull();
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v0.7.0", draft: true, prerelease: false }),
        "0.6.10",
      ),
    ).resolves.toBeNull();
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v0.7.0", draft: "false", prerelease: false }),
        "0.6.10",
      ),
    ).resolves.toBeNull();
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v0.7.0", draft: false, prerelease: null }),
        "0.6.10",
      ),
    ).resolves.toBeNull();
    await expect(
      checkForUpdate(httpResponse({ draft: false, prerelease: false }), "0.6.10"),
    ).resolves.toBeNull();
    await expect(
      checkForUpdate(
        httpResponse({ tag_name: "v01.7.0", draft: false, prerelease: false }),
        "0.6.10",
      ),
    ).resolves.toBeNull();
  });

  it("bleibt bei http- und json-fehlern still", async () => {
    await expect(checkForUpdate(httpResponse({}, 503), "0.6.10")).resolves.toBeNull();
    await expect(
      checkForUpdate(
        {
          get: async () => ({ status: 200, ok: true, text: "kein json", headers: {} }),
        },
        "0.6.10",
      ),
    ).resolves.toBeNull();
    await expect(
      checkForUpdate(
        {
          get: async () => {
            throw new Error("offline");
          },
        },
        "0.6.10",
      ),
    ).resolves.toBeNull();
  });
});
