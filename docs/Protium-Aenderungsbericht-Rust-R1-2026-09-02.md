# Protium Änderungsbericht: Rust-Reduktion R1 2026-09-02

## Ergebnis

R1 reduziert `src-tauri/src` von 13.443 auf 13.138 Zeilen. Netto entfallen
305 Rust-Zeilen, elf Tests und sechs ausschließlich test-only Helper. Zwei
produktive Pfadhelper delegieren jetzt an die Rust-Standardbibliothek.

Keine Produktfunktion, Tauri-Command-Signatur, IPC-Form, Capability,
Abhängigkeit oder Sicherheitsinvariante änderte sich.

## Geänderte Dateien

### `src-tauri/src/commands/path.rs`

Umfang: 402 auf 219 Zeilen, netto minus 183.

Produktive Vereinfachungen:

- `is_descendant_of` ersetzte die eigene Zwei-Iterator-Schleife durch
  `child.starts_with(ancestor)`. `Path::starts_with` vergleicht
  Pfadkomponenten und erhält Gleichheit, echten Nachfahren, anderen Zweig und
  Prefix-Trick-Verhalten.
- `next_existing_ancestor` ersetzte die manuelle Parent-Schleife durch
  `Path::ancestors().find(...)`. Der alte Startpunkt bleibt exakt: Ein
  vorhandenes Verzeichnis startet bei sich selbst, jeder andere Pfad bei
  seinem Parent. Eine vorhandene reguläre Datei wird nicht zurückgegeben.
- Ein reiner Was-Kommentar über `is_descendant_of` entfiel im Simplify-Pass.

Entfernte test-only Helper:

- `ensure_dest_within_canon_dir`
- `validate_download_dest`

Entfernte Tests:

- `validate_dest_im_cache_dir_ok`
- `validate_dest_etc_passwd_abgelehnt`
- `validate_dest_nichtexistenter_parent_ausserhalb_abgelehnt`
- `validate_dest_symlink_abgelehnt`
- `validate_dest_prefix_trick_abgelehnt`
- `validate_dest_cache_erbt_nicht_vom_vorfahren`

Diese Funktionen waren `#[cfg(test)]` und hatten keinen produktiven Aufrufer.
Der aktuelle Downloadpfad nutzt einen anonymen, descriptor-gebundenen
`O_TMPFILE`-Ablauf.

Unverändert:

- `sanitize_path`, `is_safe_path`, `canonicalize_safe` und
  `canonicalize_no_symlink`.
- Archiv-Linkprüfung in `link_target_stays_inside`.
- Alle fünf Archiv-Linktests und die aktiven Pfad-/Blocklist-Tests.

### `src-tauri/src/commands/scope.rs`

Umfang: 1.200 auf 1.117 Zeilen, netto minus 83.

Entfernte test-only Helper:

- `is_system_compat_dir`
- `validate_library_scope`

Entfernte Tests:

- `library_scope_validator_lehnt_home_ab`
- `library_scope_validator_akzeptiert_steamapps_kandidat`
- `library_scope_validator_akzeptiert_system_compat_dir`
- `library_scope_validator_lehnt_steam_root_ohne_suffix_ab`

Die entfernten Tests prüften nur den entfernten Legacy-Validator. Der
produktive Autorisierungspfad läuft über `EnvironmentSnapshot` und
`EnvironmentState`.

Unverändert:

- Environment-Discovery und Snapshot-Ersetzung.
- Root-, Alias-, Symlink- und System-Compat-Prüfungen.
- Autorisierung vorhandener, fehlender, optionaler und gebatchter Pfade.
- Lock- und Generation-Vertrag.
- Alle aktiven Scope- und Snapshot-Tests.

### `src-tauri/src/commands/cleanup.rs`

Umfang: 141 auf 106 Zeilen, netto minus 35.

Entfernt:

- test-only Helper `list_trash_entries_inner`;
- Test `trash_list_unscoped_library_abgelehnt`;
- ausschließlich daran hängende test-only Imports.

Der Test brach im injizierten `scope_ok = false` ab und erreichte den
produktiven Reader nie.

Unverändert:

- `list_trash_entries_at` einschließlich Library-, `steamapps`- und
  Trash-Symlink-Guards.
- Tauri-Command `list_trash_entries`.
- Autorisierung durch `EnvironmentState::with_authorized_library`.
- Serialisierte Trash-Daten.

### `src-tauri/src/commands/mod.rs`

Umfang: 47 auf 43 Zeilen, netto minus 4.

Entfernt:

- `commands::test_util::trash_fixture`, dessen einziger Aufrufer der entfernte
  Cleanup-Test war.

Unverändert:

- `fixture_dir` und `wsg_fixture`; beide bleiben aktiv genutzt.
- Modulregistrierung und `spawn_blocking_io`.

## Bewusst nicht geändert

- `delete_ops.rs` und `delete_inspect.rs`.
- `steam.rs` und das Write-Gate.
- Produktive Environment-Autorisierung in `scope.rs`.
- `download.rs`, `extract.rs` und `ge_install.rs`.
- Beide Delete-Inspections, Claim, Restore-Guard und Handle-Bindung.
- Archivdurchläufe, Hardlink-/Symlink-Policy und Cancel-Vertrag.
- Race-Hooks und statische Sicherheitsarchitekturtests.
- Keine neue Modulschicht, Kontextstruktur oder Fehlerhierarchie.

## Testbilanz

- Rust vorher: 249 Tests.
- Rust nachher: 238 Tests.
- Differenz: exakt elf obsolete Altpfad-Tests.
- Frontend unverändert: 665 Vitest.

## Reviews und Prüfungen

- Luna-Max-SDD-Review: APPROVE.
- Luna-Max-Testplan-Nachreview: APPROVE.
- Luna-Max-Diff-/Sicherheitsreview: APPROVE.
- Luna-Max-Test-/Simplify-Review: APPROVE.
- Zentraler Simplify-, Scope-, Invarianten- und Sicherheitsreview: ohne
  Befund.
- Referenzsuche: keine Rust-Referenz auf die sechs entfernten Helper.
- `npm run check`: grün, 119 Dateien.
- `npm test`: grün, 54 Dateien, 665 Tests.
- `npm run vite:build`: grün.
- `cargo fmt --check`: grün.
- `cargo build`: grün.
- `cargo test`: grün, 238 Tests.
- `cargo clippy --all-targets -- -D warnings`: grün.

Keine Git-Operation ausgeführt.
