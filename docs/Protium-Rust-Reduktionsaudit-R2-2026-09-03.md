# Protium Rust-Reduktionsaudit R2 2026-09-03

## Ergebnis

R2 findet kein risikoarmes aktives Produktionspaket mit sinnvoller
Netto-Reduktion. Der Rust-Stand bleibt bei 13.138 Zeilen und 238 Tests.
Produktcode, Commands, IPC, Capabilities und Abhängigkeiten bleiben
unverändert.

Das ist eine Stop-Entscheidung nach dem Lightweight-Prinzip: Eine Änderung
von wenigen Zeilen rechtfertigt keine zusätzliche Bewegung an gehärteten
Grenzen. Größere Kandidaten gehören in R3 und brauchen eine eigene
Security-Spec.

## Geprüfte R2-Fläche

- `fs_ops.rs`: aktive read-only Environment-Reads, Verzeichnisgrößen,
  Pfadidentität und ihre Race-Hooks.
- `scope.rs`: Snapshot-Datenfluss, Lock-Lebensdauer, Pfadautorisierung,
  Library-Discovery und kleine Parse-/Pfadhelper.
- `path.rs`: aktive Pfad-, Blocklist-, Zufallsnamen- und Archiv-Linkhelper.
- `shortcuts_bin.rs`: aktiver binärer VDF-Minimalparser.
- `cleanup.rs`: read-only Trash-Listing über den aktuellen Snapshot.
- `lib.rs` und `commands/mod.rs`: Command-Registrierung und Blocking-Wrapper.
- `external.rs` wurde nur auf Scope geprüft. Seine URL-, Environment- und
  Spawn-Härtung bleibt nach den Agent-Regeln unangetastet.

Alle registrierten read-only Commands besitzen aktive Frontend-Aufrufer. Die
produktiven Wrapper `spawn_blocking_io`, `read_environment_file`,
`measure_directory` und die Tauri-Commands trennen notwendige Thread-, Wire-
oder Test-Hook-Grenzen; keiner ist ein toter Parallelpfad.

## Verworfene Kandidaten

### `is_descendant_of` vollständig entfernen

Direkte `Path::starts_with`-Aufrufe würden drei Produktionszeilen und vier
Tests des Wrappers entfernen. Dafür müssten `scope.rs` und `ge_install.rs`
gleichzeitig geändert werden. Der Gewinn ist zu klein für die berührte
Environment-/GE-Autorisierungsfläche; R2 verwirft den Schritt.

### Snapshot-Lock-Prologe zusammenziehen

Sechs produktive Methoden halten den `EnvironmentState`-Mutex absichtlich bis
zum Ende ihrer autorisierten Operation. Ein gemeinsamer Closure-Wrapper spart
nach seinen eigenen Signaturen und Closure-Klammern höchstens wenige Zeilen,
fügt aber eine weitere Abstraktion über die sicherheitsrelevante
Lock-Lebensdauer ein. Ein geklonter Snapshot wäre kürzer, würde den
Widerrufsvertrag jedoch ändern. Beides ist kein R2-Paket.

### `DirectorySize::Failed` auf immer vorhandenes `detail` verengen

Produktiv wird derzeit stets `Some(detail)` erzeugt. Die Verengung spart nur
etwa zwei Produktionszeilen und entfernt eine bewusst getestete Wire-Form, in
der `detail` fehlen darf. Der bestehende TypeScript-Vertrag ist optional.
Kein ausreichender Nutzen.

### Steamapps-Pfadhelper zusammenlegen

`library_of` und `suffix_after_steamapps` könnten einen gemeinsamen
`rsplit_once`-Helper verwenden. Die Aufrufer liegen aber in
`delete_ops.rs` und `delete_inspect.rs`. Damit wäre der destruktive
Delete-Vertrag betroffen; dieser Kandidat ist für R2 ausgeschlossen und nur
mit eigener R3-Security-Spec zulässig.

### `parse_compat_id` gegen `parse_app_id` kürzen

Die doppelte Ziffernprüfung lässt sich um wenige Zeilen reduzieren. Der Helper
validiert direkte Delete-Ziele und bestimmt deren bestehende Fehlermeldungen.
Der geringe Gewinn rechtfertigt keine R2-Änderung am Delete-Gate.

### Race-Hooks oder read-only Wrapper entfernen

Die Hooks in Environment-Read und Größenmessung tragen aktive Tests für
Parent-, Root- und Kind-Tausch sowie Dateiwachstum. Ein separater
Produktionspfad würde Code duplizieren; ihre Entfernung würde belegte
TOCTOU-Regressionen kosten. Verworfen.

### Binär-VDF-Parser auf Cursorzustand umbauen

Ein Cursorobjekt würde neuen Zustand und Methoden einführen, ohne eine sichere
Netto-Reduktion zu belegen. Der Parser ist klein, tiefengedeckelt und durch
Korruptions-, Grenz- und Golden-Fixture-Tests gebunden. Verworfen.

## Messbarer R2-Vertrag

- Mindestwirkung eines R2-Pakets: mindestens 20 aktive
  Rust-Produktionszeilen netto weniger.
- Keine neue Struktur, kein Makro und kein zusätzlicher generischer Wrapper
  allein zur Zeilenreduktion.
- Keine Änderung an Delete-, Write-, Environment-Lock-, Handle-, Claim-,
  Redirect- oder Archivgarantien.
- Kein Kandidat erfüllt alle drei Bedingungen. Daher ist die korrekte
  R2-Nettoänderung null.

## Folgerung

R2 ist ohne Implementierung abgeschlossen. R3 darf die großen
Sicherheitsmodule getrennt read-only untersuchen. Ein R3-Kandidat zählt nur,
wenn eine konkrete Security-Spec die erhaltenen Garantien, Fixture-Tests,
Netto-Zeilenwirkung und Stop-Bedingungen vor jeder Umsetzung festlegt.
