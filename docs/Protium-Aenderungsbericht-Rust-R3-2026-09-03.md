# Protium Änderungsbericht: Rust-Reduktion R3 2026-09-03

## Ergebnis

R3 reduziert aktiven Rust-Produktionscode um 98 Zeilen. R3.1 entfernt den
ungebundenen Download-Parallelpfad, R3.3 den doppelten
`libraryfolders.vdf`-Parser. Gesamt-Rust sinkt von 13.138 auf 13.112 Zeilen;
die Testzahl steigt von 238 auf 242.

Keine Command-, IPC-, Capability-, Dependency-, UI- oder
Mutationsreihenfolge änderte sich. Das optionale GE-Environment-Paket wurde
vor Produktcode verworfen.

## R3.1 — ausschließlich gebundener Download

- `DownloadStorage.directory` ist ein verpflichtendes
  `DownloadDirectoryBinding` mit erwarteter `(dev, ino)`-Identität.
- Der produktive Downloadkern kennt keinen sichtbaren Zielpfad mehr.
- Parent-, Canonicalize- und Reopen-Parallelpfad sind entfernt.
- `O_TMPFILE`, Modus `0600`, Regular-File-Prüfung und derselbe Owned-Handle
  für Streamhash, Diskhash und Extraktion bleiben.
- Zwei ausschließlich ungebundene Tests entfielen. Descriptor-Mismatch,
  sichtbarer Swap, Fremdeintrag, Netzwerk, Redirect, Cancel, Größe und
  Handle-Lebensdauer bleiben regressionsgesichert.

Messung vor Testmodulen: `download.rs` minus 44 und `ge_install.rs` minus 4,
zusammen minus 48 aktive Produktionszeilen.

## R3.3 — gemeinsamer Libraryfolders-Parser

- `scope.rs` stellt einen reinen Parser für bereits gelesenen Text bereit.
- Discovery und Valve-Autorität nutzen ihn bei unverändert getrennten
  Dateiöffnungen.
- Discovery ergänzt bei gültig leerer VDF den Steam-Root; Valve liefert leer.
  Fehlende VDF behält in beiden Readern den bisherigen eigenen Fallback.
- Der doppelte Parser und Delegationswrapper in `steam.rs` sind entfernt;
  Delete importiert den Scope-Reader direkt.
- Gemeinsame Fixtures sichern Case-Insensitivität, Reihenfolge, First-wins,
  ignorierte nichtnumerische und skalare Einträge, leeren, fehlenden und
  skalaren Root sowie defekte Tokens.
- Ein Root-FD-Test führt gültige und defekte Fixtures durch den echten
  descriptor-gebundenen Valve-Reader.

Messung vor Testmodulen: netto minus 50 aktive Produktionszeilen.

## Erhaltene Sicherheitsgrenzen

- Delete-Claim, Live-Inspection, Restore und Token unverändert.
- Write-Gate, Steam-Läuft-Checks, Backup, fsync, Temp/Rename und String-Patch
  unverändert.
- Environment-Lock, Descriptor-, Symlink-, Größen- und Race-Gates bleiben.
- Redirect-, Hash-, Archiv-, Cancel- und Registry-Verträge bleiben.

## Reviews und Prüfungen

- Terra-High-SDD-/Spec- und Testplan-Nachreviews vor Umsetzung: APPROVE.
- Finaler Terra-High-Code-/Security-Review: Produktcode APPROVE.
- Finaler Testreview: initial BLOCK wegen fehlendem echten Valve-FD-Fixture-
  Test; Befund geschlossen.
- Zentraler Simplify-, Branch-, Scope-, Invarianten- und
  Dokumentationsreview: ohne weiteren Befund.
- `npm run check`: grün, 119 Dateien.
- `npm test`: grün, 54 Dateien, 665 Tests.
- `npm run vite:build`: grün.
- `cargo fmt --check`: grün.
- `cargo build`: grün.
- `cargo test`: grün, 242 Tests. Der vollständige Lauf brauchte lokalen
  TCP-Zugriff für 14 Download-Stub-Tests.
- `cargo clippy --all-targets -- -D warnings`: grün.

Keine Git-Operation ausgeführt.
