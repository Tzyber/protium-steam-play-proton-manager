import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BLOCKLIST } from "../../src/core/blocklist.js";
import { DELETE_CLAIM_PREFIX } from "../../src/core/cleanup.js";
import { EXTRACT_TEMP_PREFIX } from "../../src/core/compat.js";
import { parseError } from "../../src/core/errtext.js";
import {
  isManagedGeName,
  LEGACY_MAX_MAJOR,
  LEGACY_MAX_MINOR,
  MANAGED_GE_NAME_RE,
} from "../../src/core/geprotonNames.js";
import { MAX_APP_ID } from "../../src/core/guards.js";
import { paths, SYSTEM_COMPAT_DIRS } from "../../src/core/paths.js";
import { MAX_BINARY_VDF_DEPTH } from "../../src/core/shortcuts.js";
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

  it("bindet das Delete-Claim-Präfix an die Rust-Pipeline", () => {
    const deleteClaim = readFileSync(join(repo, "src-tauri/src/commands/delete_claim.rs"), "utf8");
    const literal = deleteClaim.match(/format!\(\s*"(\.protium-delete-claim-)\{\}"/);
    expect(literal, "delete_claim.rs muss das Claim-Präfix formatieren").not.toBeNull();
    expect(literal?.[1]).toBe(DELETE_CLAIM_PREFIX);
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
    const geproton = readFileSync(join(repo, "src/core/geprotonReleases.ts"), "utf8");

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

  it("bindet das Extraktions-Temp-Präfix an die eine Rust-Konstante (5.2)", () => {
    // Drei Stellen tragen denselben Präfix: die TS-Konstante filtert die
    // Einträge in listCompatTools, extract.rs baut damit den temporären
    // Verzeichnisnamen, ge_install.rs erkennt daran liegengebliebene reste.
    // Driftet eine davon, sieht die Webview einen extraktionsrest entweder
    // wieder als installiertes Tool (TS zu eng) oder verschluckt ein echtes
    // Tool (TS zu weit), während der Installer weiter auf den alten reste-
    // namen prüft. Die eine Quelle ist steam_layout::EXTRACT_PREFIX; beide
    // Rust-Aufrufer tragen kein zweites Literal.
    const layout = readFileSync(join(repo, "src-tauri/src/commands/steam_layout.rs"), "utf8");
    const extract = readFileSync(join(repo, "src-tauri/src/commands/extract.rs"), "utf8");
    const geInstall = readFileSync(join(repo, "src-tauri/src/commands/ge_install.rs"), "utf8");

    expect(EXTRACT_TEMP_PREFIX).toBe(".protium-extract-");

    const prefixMatch = layout.match(/const EXTRACT_PREFIX: &str = "([^"]+)";/);
    expect(prefixMatch, "EXTRACT_PREFIX fehlt in steam_layout.rs").not.toBeNull();
    expect(prefixMatch?.[1]).toBe(EXTRACT_TEMP_PREFIX);

    // extract.rs: temp_name = format!("{EXTRACT_PREFIX}{}-{}", pid, suffix).
    expect(extract, "temp_name-format! mit EXTRACT_PREFIX fehlt in extract.rs").toContain(
      'let temp_name = format!("{EXTRACT_PREFIX}{}-{}"',
    );

    // ge_install.rs: starts_with auf derselben Konstante (reste-prüfung).
    expect(geInstall, "starts_with-reste-prüfung fehlt in ge_install.rs").toContain(
      ".starts_with(steam_layout::EXTRACT_PREFIX)",
    );

    for (const [file, source] of [
      ["extract.rs", extract],
      ["ge_install.rs", geInstall],
    ] as const) {
      expect(source, `${file} trägt ein zweites Präfix-Literal`).not.toContain(
        '".protium-extract-"',
      );
    }
  });

  it("bindet den .protium-trash-Namen an steam_layout::TRASH_DIR_NAME (1.13)", () => {
    // Der Papierkorb-name steht in beiden Sprachen: Rust legt ihn an und
    // benennt den Loeschkandidaten hinein (delete_ops), die Webview baut
    // denselben Pfad in paths.ts. Driftet eine Seite, zeigt die UI einen
    // Ordner, den das Backend nie fuellt.
    const layout = readFileSync(join(repo, "src-tauri/src/commands/steam_layout.rs"), "utf8");
    const trashMatch = layout.match(/pub\(crate\) const TRASH_DIR_NAME: &str = "([^"]+)";/);
    expect(trashMatch, "TRASH_DIR_NAME fehlt in steam_layout.rs").not.toBeNull();
    expect(trashMatch?.[1]).toBe(".protium-trash");
    expect(paths.trashDir("/tmp/library")).toBe(`/tmp/library/steamapps/${trashMatch?.[1]}`);
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

    // erwartungstabelle aller rust-codes: vier sind bewusst "unknown"
    // (invalid-appid, invalid-url, invalid-id, invalid-account-id), alle
    // uebrigen tragen ihre klasse. Eine klassen-aenderung in CODE_KINDS
    // oder ein neuer code ohne eintrag faellt hier auf.
    const expectedKinds: Record<string, string> = {
      "invalid-appid": "unknown",
      "invalid-value": "blocked",
      "invalid-url": "unknown",
      "unallowed-scheme": "blocked",
      "credentials-disallowed": "blocked",
      "host-disallowed": "blocked",
      "handler-unavailable": "unavailable",
      "unsupported-platform": "unavailable",
      "steam-running": "blocked",
      // P8: ein nicht belegbarer Steam-Status blockiert schreiben/löschen,
      // ist aber keine erkannte blockade und kein "kein steam".
      "steam-check-unavailable": "unavailable",
      "steam-not-found": "not-found",
      "steam-root-symlink-unsupported": "blocked",
      "invalid-account-id": "unknown",
      "blocked-location": "blocked",
      "not-a-steam-config": "blocked",
      "unknown-tool": "blocked",
      "tool-already-exists": "blocked",
      "size-limit-exceeded": "incomplete",
      "too-large-for-trash": "blocked",
      "not-found": "not-found",
      "token-expired": "blocked",
      "token-unknown": "blocked",
      "target-changed": "blocked",
      "unsupported-target": "blocked",
      "not-a-directory": "unreadable",
      "symlink-rejected": "blocked",
      "invalid-id": "unknown",
      "not-an-orphan": "blocked",
      "library-not-listed": "blocked",
      "not-a-managed-tool": "blocked",
      "write-may-have-applied": "incomplete",
      cancelled: "unavailable",
      "checksum-failed": "incomplete",
      "unverified-rejected": "blocked",
      "download-active": "unavailable",
      "unsupported-arch": "unavailable",
      blocked: "blocked",
      unavailable: "unavailable",
      unreadable: "unreadable",
      incomplete: "incomplete",
    };
    expect(new Set(Object.keys(expectedKinds))).toEqual(new Set(codes));

    setLocale("de");
    for (const code of codes) {
      expect(parseError(code).code, `Code ${code} fehlt in CODE_KINDS`).toBe(code);
      expect(parseError(code).kind, `Code ${code} hat die falsche Klasse`).toBe(
        expectedKinds[code] ?? "<fehlt>",
      );
      // Der Fallback von formatError ist der Klassentext, nicht zwingend
      // "unknown": fuer codes der klasse unavailable oder blocked waere die
      // ersatzantwort ein anderer satz. Die assertion weist deshalb nur den
      // unknown-Fallback ab; dass ausgewaehlte codes ihren eigenen
      // codes-text tragen, pinnt tests/ui/formatError.test.ts.
      expect(
        formatError(code),
        `Code ${code} hat keinen eigenen Text (Fallback auf den Klassentext)`,
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
      // wie oben: der fallback ist der klassentext, der codes-eigene text ist
      // hier nicht gepinnt (das leistet formatError.test).
      const fallbackHint = `Code ${code} hat keinen eigenen Text (Fallback auf den Klassentext)`;
      expect(text, fallbackHint).not.toBe(t("errors.kinds.unknown"));

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
    // MOCK_TOKEN_TTL_MS liegt an zwei Stellen: im vi.hoisted der
    // cleanupStoreMocks (dort ist kein Import möglich) und in der
    // seitenwirkungsfreien tests/support/mockTokenTtl.ts. Der Test liest
    // beide Quellen wie die übrigen Spiegel mechanisch als Text: driftet
    // eine ab, prüfen die Lösch-Abläufe gegen eine Lebensdauer, die das
    // Backend nie ausgibt.
    const deleteOps = readFileSync(join(repo, "src-tauri/src/commands/delete_ops.rs"), "utf8");
    const sources = [
      readFileSync(join(repo, "tests/support/cleanupStoreMocks.ts"), "utf8"),
      readFileSync(join(repo, "tests/support/mockTokenTtl.ts"), "utf8"),
    ];
    const ttlMatch = deleteOps.match(/pub const DELETE_TOKEN_TTL_SECS: u64 = (\d+);/);
    expect(ttlMatch).not.toBeNull();
    const ttlSecs = Number(ttlMatch?.[1] ?? "");
    for (const source of sources) {
      const mockMatch = source.match(/const MOCK_TOKEN_TTL_MS = ([\d_]+);/);
      expect(mockMatch, "MOCK_TOKEN_TTL_MS fehlt in einer Quelle").not.toBeNull();
      const mockTtlMs = Number((mockMatch?.[1] ?? "").replace(/_/g, ""));
      expect(mockTtlMs).toBe(ttlSecs * 1000);
    }
  });
});
