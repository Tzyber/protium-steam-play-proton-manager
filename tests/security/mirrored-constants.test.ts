import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BLOCKLIST } from "../../src/core/blocklist.js";
import { parseError } from "../../src/core/errtext.js";
import {
  isManagedGeName,
  LEGACY_MAX_MAJOR,
  LEGACY_MAX_MINOR,
  MANAGED_GE_NAME_RE,
} from "../../src/core/geproton.js";
import { SYSTEM_COMPAT_DIRS } from "../../src/core/paths.js";
import { MAX_BINARY_VDF_DEPTH } from "../../src/core/shortcuts.js";
import { MAX_APP_ID } from "../../src/core/types.js";
import { formatDetail, formatError } from "../../src/ui/formatError.js";
import { setLocale, t } from "../../src/ui/i18n/index.js";
import { MAX_PENDING_DELETES } from "../../src/ui/stores/cleanupStore.js";

// Auflösung über den dateistandort statt über das arbeitsverzeichnis (T-11):
// der testlauf darf nicht davon abhängen, aus welchem cwd vitest startet.
const repo = resolve(import.meta.dirname, "../..");

describe("TypeScript-/Rust-Spiegelwerte", () => {
  it("bindet System-Compat-Pfade, AppID-Grenze und Shortcut-Tiefenlimit", () => {
    const scope = readFileSync(join(repo, "src-tauri/src/commands/scope.rs"), "utf8");
    const shortcuts = readFileSync(join(repo, "src-tauri/src/commands/shortcuts_bin.rs"), "utf8");

    expect(SYSTEM_COMPAT_DIRS).toEqual([
      "/usr/share/steam/compatibilitytools.d",
      "/usr/local/share/steam/compatibilitytools.d",
    ]);
    const systemCompatBlock = scope.match(
      /pub\(crate\) const SYSTEM_COMPAT_DIRS: \[&str; 2\] = \[([\s\S]*?)\];/,
    );
    expect(systemCompatBlock).not.toBeNull();
    const rustSystemCompatDirs = [...(systemCompatBlock?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(rustSystemCompatDirs).toEqual(SYSTEM_COMPAT_DIRS);

    expect(MAX_APP_ID).toBe(4_294_967_295);
    expect(scope).toContain("1..=u32::MAX as u64");

    expect(MAX_BINARY_VDF_DEPTH).toBe(64);
    expect(shortcuts).toContain("const MAX_BINARY_VDF_DEPTH: usize = 64;");
  });

  it("bindet die proton-builtin-paare aus der Blocklist an VALVE_COMPAT_TOOLS", () => {
    const compatAuth = readFileSync(join(repo, "src-tauri/src/commands/compat_auth.rs"), "utf8");
    const tableBlock = compatAuth.match(
      /const VALVE_COMPAT_TOOLS: &\[\(&str, &\[u32\]\)\] = &\[([\s\S]*?)\];/,
    );
    expect(tableBlock).not.toBeNull();
    const rustPairs = new Map<string, number[]>();
    for (const match of (tableBlock?.[1] ?? "").matchAll(/\("([^"]+)",\s*&\[([^\]]*)\]\)/g)) {
      rustPairs.set(
        match[1] ?? "",
        [...(match[2] ?? "").matchAll(/\d+/g)].map((id) => Number(id[0])),
      );
    }

    // Die Webview-Blocklist ist keine Autorität, aber sie darf nicht driften:
    // sie entscheidet, ob ein Prefix dem Cleanup als Waise angeboten wird,
    // die Rust-Tabelle entscheidet, ob das Write-Gate das Löschen autorisiert.
    const builtins = BLOCKLIST.filter((entry) => entry.category === "proton-builtin");
    expect(builtins.length).toBeGreaterThan(0);
    for (const entry of builtins) {
      const name = entry.toolName;
      expect(name, `toolName fehlt für ${entry.appId}`).toBeTruthy();
      expect(
        rustPairs.get(name ?? ""),
        `VALVE_COMPAT_TOOLS fehlt der interne name "${name}"`,
      ).toContain(entry.appId);
    }

    // Rückrichtung (Q-04): jeder Rust-eintrag braucht seinen TS-gegenpart mit
    // denselben AppIDs. Ohne den Loop fiele ein neuer Rust-name durch, den die
    // Webview-Blocklist nicht kennt.
    for (const [name, appIds] of rustPairs) {
      const tsIds = BLOCKLIST.filter((entry) => entry.toolName === name).map(
        (entry) => entry.appId,
      );
      expect(
        tsIds.sort((a, b) => a - b),
        `BLOCKLIST fehlt der tool-name "${name}"`,
      ).toEqual([...appIds].sort((a, b) => a - b));
    }
  });

  it("bindet die GE-Namens- und Legacy-Regeln an Rust (Q-01)", () => {
    const compatAuth = readFileSync(join(repo, "src-tauri/src/commands/compat_auth.rs"), "utf8");
    const geInstall = readFileSync(join(repo, "src-tauri/src/commands/ge_install.rs"), "utf8");
    const geproton = readFileSync(join(repo, "src/core/geproton.ts"), "utf8");

    // MANAGED_GE_NAME_RE spiegelt compat_auth::is_managed_ge_name: prefix,
    // versionsnummern, optionale arch-suffixe. Beide Seiten müssen dieselbe
    // form akzeptieren, sonst lehnt ein installiertes tool eine der beiden ab.
    expect(MANAGED_GE_NAME_RE.source).toContain("(x86_64|aarch64)");
    expect(compatAuth).toContain('strip_prefix("GE-Proton")');
    expect(compatAuth).toContain("is_legacy_ge_version");
    for (const arch of ["x86_64", "aarch64"]) {
      expect(MANAGED_GE_NAME_RE.test(`GE-Proton11-4-${arch}`)).toBe(true);
      expect(isManagedGeName(`GE-Proton11-4-${arch}`)).toBe(true);
      expect(compatAuth).toContain(`"${arch}"`);
    }

    // Legacy-Schwelle aus einer quelle: die TS-konstanten müssen den
    // rust-ausdruck in ge_install.rs treffen.
    expect(LEGACY_MAX_MAJOR).toBe(11);
    expect(LEGACY_MAX_MINOR).toBe(3);
    expect(geInstall).toContain(
      `major < ${LEGACY_MAX_MAJOR} || (major == ${LEGACY_MAX_MAJOR} && minor <= ${LEGACY_MAX_MINOR})`,
    );
    expect(isManagedGeName(`GE-Proton${LEGACY_MAX_MAJOR}-${LEGACY_MAX_MINOR}`)).toBe(true);
    expect(isManagedGeName(`GE-Proton${LEGACY_MAX_MAJOR}-${LEGACY_MAX_MINOR + 1}`)).toBe(false);

    // Asset-pfad: die exakte download-route steht in beiden seiten gleich.
    const assetPath = "/GloriousEggroll/proton-ge-custom/releases/download/";
    expect(geInstall).toContain(assetPath);
    expect(geproton).toContain(assetPath);
  });

  it("bindet das Delete-Batch-Limit an die Rust-Registry", () => {
    const deleteOps = readFileSync(join(repo, "src-tauri/src/commands/delete_ops.rs"), "utf8");

    expect(MAX_PENDING_DELETES).toBe(32);
    expect(deleteOps).toContain("pub const MAX_PENDING_DELETES: usize = 32;");
    expect(deleteOps).toContain("pub const DELETE_TOKEN_TTL_SECS: u64 = 300;");
  });

  it("bindet jeden Rust-Fehlercode an Klasse und Text der Oberflaeche", () => {
    // Die Codes liegen in vier Stellen (errcode.rs, CODE_KINDS, CODE_KEYS,
    // i18n de/en). Der Test haelt sie zusammen: ein neuer Code ohne
    // Uebersetzung oder ohne Klassifikation faellt hier auf.
    const errcode = readFileSync(join(repo, "src-tauri/src/commands/errcode.rs"), "utf8");
    const codes = [
      ...errcode.matchAll(/pub\(crate\) const [A-Z0-9_]+: &str = "([a-z0-9-]+)";/g),
    ].map((match) => match[1] ?? "");
    expect(codes.length).toBeGreaterThan(20);

    setLocale("de");
    for (const code of codes) {
      expect(parseError(code).code, `Code ${code} fehlt in CODE_KINDS`).toBe(code);
      expect(
        formatError(code),
        `Code ${code} hat keinen eigenen Text (Fallback auf unknown)`,
      ).not.toBe(t("errors.kinds.unknown"));
    }
  });

  // Q-03-Regressionsschutz: diese vier Codes existieren NUR auf der TS-Seite
  // (manifest.ts, cleanupHelpers.ts) und stehen nicht in errcode.rs. Der Test
  // oben ueber die Rust-Codes kann sie deshalb nicht abdecken. Faellt hier ein
  // Code aus CODE_KINDS, CODE_KEYS oder der i18n, ginge die Klasse verloren und
  // parseError fiele beim gespeicherten Rohstring der Scan-Warnungen still auf
  // "unknown" zurueck (Detail dann ohne Uebersetzung).
  it("haelt die vier TS-only-Fehlercodes klassifiziert und uebersetzt (Q-03)", () => {
    const expected: Record<string, string> = {
      "size-invalid": "incomplete",
      "size-missing": "incomplete",
      "manifest-missing-appstate": "unreadable",
      "manifest-invalid-appid": "incomplete",
    };

    setLocale("de");
    for (const [code, kind] of Object.entries(expected)) {
      expect(parseError(code).code, `Code ${code} fehlt in CODE_KINDS`).toBe(code);
      expect(parseError(code).kind, `Code ${code} hat die falsche Klasse`).toBe(kind);

      const text = formatError(code);
      expect(text, `Code ${code} hat keinen eigenen Text (Fallback auf unknown)`).not.toBe(
        t("errors.kinds.unknown"),
      );

      // gespeicherter Rohstring, Format "code: detail" wie in den Scan-Warnungen.
      const stored = `${code}: /pfad/zum/manifest.acf`;
      expect(formatDetail(stored), `Detail fuer ${code} wird verworfen`).toBe(text);
    }
  });

  it("bindet die Token-TTL der Doku an den Rust-Wert (C1)", () => {
    // SECURITY.md nannte 60 Sekunden, der Code 300. Der Test hält beide
    // zusammen, damit die Doku nicht wieder driftet.
    const deleteOps = readFileSync(join(repo, "src-tauri/src/commands/delete_ops.rs"), "utf8");
    const security = readFileSync(join(repo, "SECURITY.md"), "utf8");
    const ttlMatch = deleteOps.match(/pub const DELETE_TOKEN_TTL_SECS: u64 = (\d+);/);
    expect(ttlMatch).not.toBeNull();
    const ttl = ttlMatch?.[1] ?? "";

    expect(security).toContain(`${ttl} Sekunden TTL`);
    expect(security).not.toMatch(/60 Sekunden TTL/);
  });

  it("bindet die Mock-Token-Lebensdauer der Tests an DELETE_TOKEN_TTL_SECS", () => {
    // MOCK_TOKEN_TTL_MS (tests/support/cleanupStoreMocks.ts) spiegelte den
    // Rust-Wert bisher nur im Kommentar. Der Test liest beide Quellen wie die
    // übrigen Spiegel mechanisch als Text: driftet der Mock ab, prüfen die
    // Lösch-Abläufe gegen eine Lebensdauer, die das Backend nie ausgibt.
    const deleteOps = readFileSync(join(repo, "src-tauri/src/commands/delete_ops.rs"), "utf8");
    const mocks = readFileSync(join(repo, "tests/support/cleanupStoreMocks.ts"), "utf8");
    const ttlMatch = deleteOps.match(/pub const DELETE_TOKEN_TTL_SECS: u64 = (\d+);/);
    const mockMatch = mocks.match(/const MOCK_TOKEN_TTL_MS = ([\d_]+);/);
    expect(ttlMatch).not.toBeNull();
    expect(mockMatch).not.toBeNull();
    const ttlSecs = Number(ttlMatch?.[1] ?? "");
    const mockTtlMs = Number((mockMatch?.[1] ?? "").replace(/_/g, ""));
    expect(mockTtlMs).toBe(ttlSecs * 1000);
  });
});
