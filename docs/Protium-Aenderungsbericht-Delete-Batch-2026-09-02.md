# Protium Änderungsbericht: Delete-Batch 2026-09-02

## Ergebnis

Delete-Batches sind an die native Registry-Grenze von 32 Zielen gebunden.
Direkte größere Auswahlen brechen atomar vor jedem Prepare und jeder weiteren
Löschstufe ab. `emptyTrash` verarbeitet höchstens die ersten 32 Einträge des
aktuellen Store-Snapshots. Die Token-TTL beträgt fünf Minuten.

## Produktdateien

### `src/ui/stores/cleanupStore.ts`

Geändert:

- `MAX_PENDING_DELETES = 32` als produktive UI-Grenze ergänzt.
- `deleteOrphans(entries)` bricht bei mehr als 32 Zielen vor Scan-, Steam-,
  Shortcut-, Reservation-, Prepare-, Dialog- und Execute-Logik ab.
- `deleteTrashEntries(entries)` bricht bei mehr als 32 Zielen vor Scan-,
  Reservation-, Prepare-, Dialog- und Execute-Logik ab.
- Beide Fehlerpfade nennen angeforderte Anzahl und Maximum.
- Trash-Dialogtitel verwenden die Zahl der erfolgreich vorbereiteten Ziele.
  Das gilt auch bei Teil-Prepare mit nur einem erfolgreichen Ziel.
- `emptyTrash()` übergibt eine Kopie der ersten 32 Store-Snapshot-Einträge.
  Einträge ab Index 32 bleiben für den nächsten Lauf stehen.

Nicht geändert:

- Keine neue Store-Abstraktion, Queue oder Blockverarbeitung.
- Confirm-Reservation, Cancel-Verhalten, Teilfehler und Execute-Reihenfolge.
- Orphan-Revalidierung gegen Scan, laufendes Steam und Shortcuts.
- Keine direkte Dateisystemmutation im Frontend.

### `src/ui/i18n/de.ts`

Geändert:

- Trash-Dialogtitel enthält die vorbereitete Anzahl.
- Neue Über-Limit-Meldung mit `{n}` und `{max}`.

### `src/ui/i18n/en.ts`

Geändert:

- Englische Entsprechungen mit identischen Platzhaltern ergänzt.

### `src-tauri/src/commands/delete_ops.rs`

Geändert:

- `DELETE_TOKEN_TTL_SECS`: 60 auf 300 Sekunden.

Nicht geändert:

- `MAX_PENDING_DELETES` bleibt 32.
- Registry-Struktur, Mutex und deterministische Verdrängung.
- OS-Zufallstoken und Replay-Schutz.
- Beide Steam-Checks und beide Execute-Inspections.
- Ziel- und Parent-Handle-Bindung, Inode-Prüfung und Claim-Rename.
- Restore-Guard und fail-closed Fehlerpfade.
- Keine neue Rust-Funktion, Struktur, Abstraktion oder Capability.

## Tests

### `tests/ui/cleanupStore.test.ts`

Neu oder erweitert:

- 33 Orphans brechen vor allen Gates ab; Zustand bleibt unverändert.
- Exakt 32 Orphans werden in einem Dialog vorbereitet und ausgeführt.
- 33 direkte Trash-Ziele brechen atomar ab.
- Exakt 32 Trash-Ziele werden in einem Dialog vorbereitet und ausgeführt.
- `emptyTrash` mit 33 Einträgen verarbeitet Indizes 0 bis 31 und lässt Index
  32 stehen.
- Der vorhandene Teil-Prepare-Test prüft zusätzlich die tatsächliche
  Dialogzahl eins.

Entfernt oder zusammengelegt:

- Vier locale-duplizierte Über-Limit-Fälle entfernt. Orphans prüfen Deutsch,
  Trash prüft Englisch; der bestehende i18n-Paritätstest sichert Schlüssel und
  Platzhalter beider Sprachen.
- Der alte Test `emptyTrash löscht alle einträge` entfernt. Direkter
  Trash-Happy-Path, Snapshot-Delegation und 33er-`emptyTrash` decken denselben
  Vertrag genauer ab.

### `tests/ui/i18n.test.ts`

Entfernt:

- Ein zusätzlicher Test nur für die Zahlen 33 und 32. Die beiden Store-Tests
  prüfen die sichtbaren Meldungen bereits in Deutsch und Englisch; Key- und
  Placeholder-Parität bestand schon.

### `tests/security/mirrored-constants.test.ts`

Geändert:

- Importiert die produktive UI-Grenze.
- Pinnt UI 32 gegen Rust 32 sowie die ausschließlich native TTL 300 gegen den
  Rust-Quelltext.

### Rust-Tests in `src-tauri/src/commands/delete_ops.rs`

Entfernt:

- Ein neuer reiner Literaltest für 32 und 300. Er war doppelt zum
  Spiegeltest. Der bestehende Registry-Test sichert weiterhin Cap,
  Verdrängung und die berechnete TTL.

Testbilanz:

- Erste Implementierungsfassung: zehn neue Tests.
- Final nach Simplify-Pass: fünf neue Vertragsfälle netto.
- Gesamtsuite: 665 Vitest und 249 Rust-Tests.

## Dokumentation

Geändert oder ergänzt:

- `docs/notizen/spezifikationen/delete-batch-vertrag-2026-09-02.md`
- `docs/notizen/plaene/externer-code-review-folgeplan-2026-09-02.md`
- `docs/notizen/vorhaben/externer-code-review-2026-09-02.md`
- `docs/notizen/tagesnotizen/2026-09-02.md`
- `docs/notizen/Aufgaben.md`
- `HANDOFF.md`
- `docs/notizen/vorhaben/rust-schicht-vereinfachen-2026-09-02.md`

## Bewusst nicht übernommen

- Registry-Cap auf 256 erhöhen.
- Mehrere Prepare-/Dialog-/Execute-Blöcke einführen.
- Zweite Execute-Inspection entfernen.
- Pending-Delete auf einen einzelnen Handle reduzieren.
- Confirm-Store oder Delete-Pipeline abstrahieren.
- Neue Fehlerhierarchie, Capability, Dependency oder Tauri-Command.
- Größere Rust-Refactors im sicherheitskritischen Delete-Fix verstecken.

Der gewünschte echte Rust-Refactor ist als getrenntes Vorhaben erfasst. Er
beginnt read-only mit einem Reduktionsinventar und braucht für Delete-, Write-,
Scope- oder Archivpfade eine eigene Spec und Freigabe.

## Reviews und Prüfungen

- Luna-Max-Diffreview: APPROVE.
- Luna-Max-Test-/Simplify-Review: APPROVE.
- Zentraler Gesamt-, Scope-, Invarianten- und Sicherheitsreview: ohne Befund.
- `npm run check`: grün, 119 Dateien.
- `npm test`: grün, 54 Dateien, 665 Tests.
- `npm run vite:build`: grün.
- `cargo fmt --check`: grün.
- `cargo build`: grün.
- `cargo test`: grün, 249 Tests.
- `cargo clippy --all-targets -- -D warnings`: grün.
