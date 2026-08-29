import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const capability = readFileSync(
  resolve(import.meta.dirname, "../../src-tauri/capabilities/default.json"),
  "utf8",
);

describe("github http capability", () => {
  it("erlaubt nur die zwei von Protium verwendeten github-api-endpunkte", () => {
    expect(capability).toContain(
      "https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=15",
    );
    expect(capability).toContain(
      "https://api.github.com/repos/Tzyber/protium-steam-play-proton-manager/releases/latest",
    );
    expect(capability).not.toContain("https://api.github.com/*");
  });
});
