# Protium Rust-Reduktionsaudit 2026-09-02

## Ausgangslage

`src-tauri/src` enthält 13.443 Zeilen Rust. Rund 6.500 Zeilen liegen vor den
eingebetteten Testmodulen; rund 6.900 Zeilen gehören zu Tests und
Testinfrastruktur. Die größten Dateien sind:

- `steam.rs`: 3.302 Zeilen, Testmodul ab Zeile 1.204.
- `delete_ops.rs`: 1.640 Zeilen, Testmodul ab Zeile 650.
- `download.rs`: 1.452 Zeilen, Testmodul ab Zeile 569.
- `scope.rs`: 1.200 Zeilen, Testmodul ab Zeile 787.
- `fs_ops.rs`: 1.180 Zeilen, Testmodul ab Zeile 444.
- `ge_install.rs`: 1.166 Zeilen, Testmodul ab Zeile 632.

Die Dateigröße allein ist kein Refactor-Grund. Ein Split würde Zeilen und
Abstraktionen erhöhen, ohne Verhalten zu vereinfachen. Der erste Schnitt muss
löschen, nicht verschieben.

## Bestätigte Löschkandidaten

### `path.rs`: tote Download-Ziel-Altstrecke

`ensure_dest_within_canon_dir` und `validate_download_dest` sind
`#[cfg(test)]` und werden ausschließlich von sechs Tests derselben Altstrecke
aufgerufen. Der produktive Download verwendet den anonymen, an einen
Directory-Descriptor gebundenen `O_TMPFILE`-Pfad. Die alten Zielpfad-Helper
prüfen keinen aktuellen Produktpfad.

Entfernbar:

- beide test-only Funktionen;
- sechs `validate_dest_*`-Tests;
- ausschließlich daran hängende Imports und Kommentare.

### `scope.rs` und `cleanup.rs`: legacy Scope-Testpfad

`scope::validate_library_scope` und `scope::is_system_compat_dir` sind
`#[cfg(test)]`. Vier Tests prüfen nur diesen alten Validator. Der produktive
Scope läuft über `EnvironmentSnapshot` und `EnvironmentState`.

`cleanup::list_trash_entries_inner` ist ebenfalls `#[cfg(test)]`. Sein einziger
Test injiziert `scope_ok = false` in diesen Testhelper. Der produktive Command
ruft stattdessen `EnvironmentState::with_authorized_library` auf; dessen
Autorisierungsvertrag besitzt eigene Snapshot-Tests.

Entfernbar:

- drei test-only Helper;
- fünf Tests;
- test-only Imports und `commands::test_util::trash_fixture`, dessen einziger
  Aufrufer der entfernte Cleanup-Test ist. `fixture_dir` und `wsg_fixture`
  bleiben aktiv.

## Bestätigte Produktionsvereinfachungen

### `is_descendant_of`

Die Funktion implementiert `Path::starts_with` mit zwei Iteratoren und einer
Schleife selbst. Ihr Kommentar bestätigt bereits die identische
komponentenbasierte Semantik. Ersetzung durch `child.starts_with(ancestor)`
entfernt eigenen Kontrollfluss. Die vier bestehenden Prefix-/Gleichheits-
Tests bleiben.

### `next_existing_ancestor`

Die manuelle Parent-Schleife lässt sich durch `Path::ancestors().find(...)`
ersetzen. Der Startpunkt bleibt exakt erhalten: vorhandenes Verzeichnis selbst,
sonst Parent. Aufrufer und Fehlertexte bleiben unverändert.

## Bewusst nicht kürzen

- Zweite Delete-Inspection: schließt die Änderung während des zweiten
  Steam-Checks.
- Parent- und Ziel-Handle: binden unterschiedliche Teile der Mutation.
- Claim-/Restore-Guard: verhindert falsches Löschen bei Pfadtausch.
- Environment-Lock: aktueller Widerrufsvertrag; Änderung braucht Messung und
  neue Sicherheitsentscheidung.
- Drei GE-Archivdurchläufe: Kürzung braucht Checksumme-/Handle-Entscheidung
  und vollständige Archiv-Fixtures.
- Race-Hooks in Delete, Write, Read und Extract: sie tragen aktive
  TOCTOU-Regressionstests.
- Source-Inspection-Tests für Claim, Dialoggrenze, `O_TMPFILE` und direkte
  IPC-Bindung: sie pinnen Sicherheitsarchitektur, nicht Zeilendetails ohne
  Vertrag.
- Dateisplit von `steam.rs`: verschiebt Komplexität und erzeugt mehr Module,
  ohne Code zu entfernen.
- Gemeinsamer Kontext für Funktionen mit vielen Argumenten: erzeugt neue
  Zustandsobjekte und macht die Schicht nicht flacher.

## Paket R1: erwartete Wirkung

- Elf ausschließlich alte Testpfad-Tests entfallen.
- Sechs ausschließlich test-only Helper entfallen.
- Zwei produktive Pfadhelper werden auf Rust-Stdlib reduziert.
- Netto-Quelltext sinkt voraussichtlich um mehr als 250 Zeilen.
- Aktive Tauri-Commands, IPC-Formen, Capabilities und Produktverhalten bleiben
  unverändert.
- Delete-, Steam-Write- und Archivmutation bleiben bytegleich.

Weitere Rust-Pakete werden erst nach dem gemessenen R1-Ergebnis geplant. Jede
weitere Stufe muss Produktionscode netto reduzieren; reine Dateiverschiebung
gilt nicht als Refactor-Erfolg.
