import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// F-02 (vorige Runde): das Gate-Parsing selbst war ungetestet; `--max-blocks=Wert`
// wurde stillschweigend ignoriert (exit 0). Der Test faehrt das Skript als
// Prozess, genau wie ein Gate-Aufruf es tut.
// F-05 (Neuaudit): der grenztest lief gegen den duplikatbestand des repos und
// waere nach der dedup-arbeit am eigenen erfolg rot geworden (0 duplikate,
// gate korrekt exit 0). Er faehrt jetzt gegen eine fixture mit garantiertem
// block-duplikat; der repo-bestand ist fuer das gate-verhalten irrelevant.
const repo = resolve(import.meta.dirname, "../..");
const script = resolve(repo, "scripts", "dedup-scan.mjs");

function runDedup(
  cwd: string,
  ...args: readonly string[]
): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    // Die fixture ist auf die default-grenze 6 ausgelegt; eine im umfeld
    // gesetzte tuning-variable darf das gate-ergebnis des tests nicht kippen.
    env: { ...process.env, MIN_BLOCK: "6" },
  });
  return { status: result.status, stderr: result.stderr };
}

// Sieben gezaehlte zeilen (die schliessende klammer filtert der scanner als
// strukturzeile) in zwei dateien: genau ein block-duplikat ueber der
// MIN_BLOCK-grenze (6).
const DUPLICATE_BLOCK = [
  "export function shared(name: string): string {",
  "  const trimmed = name.trim();",
  "  const lowered = trimmed.toLowerCase();",
  '  const cleaned = lowered.replaceAll(" ", "-");',
  '  const prefixed = ["tool", cleaned].join("-");',
  "  const verified = prefixed.length > 0;",
  '  return verified ? prefixed : "tool";',
  "}",
].join("\n");

describe("dedup-scan max-blocks-gate", () => {
  let fixture: string;

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), "protium-dedup-scan-"));
    // Das skript liest seine drei wurzeln relativ zum cwd; die fixture legt
    // sie alle an und traegt nur in `src` inhalt.
    for (const root of ["src", "tests", join("src-tauri", "src")]) {
      mkdirSync(join(fixture, root), { recursive: true });
    }
    for (const file of ["shared-links.ts", "shared-rechts.ts"]) {
      writeFileSync(join(fixture, "src", file), `${DUPLICATE_BLOCK}\n`);
    }
  });

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it("laesst die fixture unter der grenze gruen durch", () => {
    const result = runDedup(fixture, "--max-blocks", "999");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 30_000);

  it("reisst die grenze in beiden schreibweisen", () => {
    // 0 ist die strengste grenze: sie reisst am fixture-duplikat, das
    // unabhaengig von der groesse des repos garantiert ist.
    const spaced = runDedup(fixture, "--max-blocks", "0");
    expect(spaced.status).toBe(1);
    expect(spaced.stderr).toContain("dedup-gate:");

    const inline = runDedup(fixture, "--max-blocks=0");
    expect(inline.status).toBe(1);
    expect(inline.stderr).toContain("dedup-gate:");
  }, 60_000);

  it("weist ungueltige werte ab, statt sie zu interpretieren", () => {
    for (const value of ["abc", "1e3", "0x10", "", "-1"]) {
      const result = runDedup(fixture, `--max-blocks=${value}`);
      expect(result.status, `wert ${JSON.stringify(value)}`).toBe(1);
      expect(result.stderr, `wert ${JSON.stringify(value)}`).toContain("erwartet eine ganze zahl");
    }

    const missing = runDedup(fixture, "--max-blocks");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("erwartet eine ganze zahl");
  }, 60_000);
});
