# Protium Rust-Reduktionsaudit R3 2026-09-03

## Ergebnis

R3 bestätigt zwei getrennte Produktionspakete mit zusammen mindestens 75
aktiven Rust-Zeilen Netto-Reduktion. Sie entfernen einen heute nur für Tests
offenen Parallelpfad und einen doppelten Parser. Keine Sicherheitsstufe
entfällt.

Beide Pakete wurden nach ausdrücklicher Freigabe umgesetzt. Aktiver
Produktionscode sinkt netto um 98 Zeilen: R3.1 minus 48, R3.3 minus 50.
Gesamt-Rust sinkt trotz zusätzlicher Regressionstests von 13.138 auf 13.112
Zeilen. 242 Rust-Tests und alle Abschlussgates sind grün.

## R3.1 — Download nur über gebundenen Directory-Descriptor

### Befund

Der produktive GE-Pfad übergibt `DownloadStorage.directory` immer als
`Some(DownloadDirectoryBinding)`. Nur der `#[cfg(test)]`-Wrapper verwendet
`None`. Trotzdem kompiliert `download.rs` einen zweiten produktiven
Öffnungspfad aus dem sichtbaren `dest`-Pfad: Parent anlegen,
`symlink_metadata`, canonicalize, Identität erfassen, Directory erneut öffnen
und vergleichen.

Dieser Parallelpfad ist für die Anwendung unerreichbar. Der echte Pfad öffnet
das anonyme `O_TMPFILE` ausschließlich relativ zu dem bereits gebundenen und
identitätsgeprüften Directory-Descriptor.

### Reduktion

- `DownloadStorage.directory` wird verpflichtend statt `Option`.
- `download_stream_in_directory` und `open_anonymous_download_file` erhalten
  keinen sichtbaren Zielpfad mehr.
- Der unerreichbare pfadbasierte Parent-/Canonicalize-/Reopen-Zweig entfällt.
- `ge_install.rs` entfernt `download_file_name`, `download_path` und
  `download_path_str`; für `O_TMPFILE` existiert kein Dateiname.
- Der Testwrapper bindet sein temporäres Verzeichnis wie die Produktion.

Erwartung: mindestens 40 aktive Produktionszeilen netto weniger.

### Erhaltene Garantien

- Linux-`O_TMPFILE`, Modus `0600`, Regular-File- und `(dev, ino)`-Prüfung.
- Sichtbarer Pfad wird weder erstellt, geöffnet noch gelöscht.
- Derselbe Owned-File-Handle bleibt für Streamhash, Diskhash und beide
  Archivpässe geöffnet.
- Redirect-, Größen-, Timeout-, Cancel- und Registry-Vertrag bleiben gleich.
- Ein sichtbarer Directory-Tausch nach Descriptor-Bindung erreicht nur den
  gebundenen alten Directory-Inode; fremde Einträge bleiben unberührt.

## Verworfener Kandidat — GE-Installation braucht immer `EnvironmentState`

### Befund

`install_ge_proton` ruft `install_ge_proton_inner` produktiv immer mit
`Some(EnvironmentState)` und einer `scope_ok`-Closure auf. `None` existiert
nur, damit direkte Tests die Backend-Autorität umgehen können. Dadurch trägt
der Produktionscode zwei Autoritätspfade und mehrere Root-/Tools-Klone.

### Review-Entscheidung

- Der aktuelle Command autorisiert zuerst die kompilierte Architektur, dann
  den Environment-Snapshot, löst erst danach den Cache auf und registriert
  zuletzt den Download vor dem Inner-Aufruf.
- Ein Verschieben der Autorisierung ins Innere könnte Fehlerpräzedenz und
  Registry-Seiteneffekte ändern.
- Ein belastbarer Command-Level-Test benötigt Tauri-Runtime-Aufbau oder eine
  neue testbare Orchestrierungsnaht. Beides erhöht Zustand und Abstraktion und
  gefährdet das Nettoziel.
- R3.2 wird vor Produktcode verworfen. Äußere Vorautorisierung, optionaler
  Testpfad und Lock-Lebensdauer bleiben unverändert.

## R3.3 — ein Libraryfolders-Parser

### Befund

`scope.rs::read_library_paths` und
`steam.rs::parse_library_folder_paths` implementieren denselben Text-VDF-
Parser getrennt: Rootblock suchen, numerische Library-Blöcke filtern,
`path`-Wert lesen und Duplikate entfernen. Die Dateizugriffe dürfen nicht
vereinheitlicht werden: Discovery nutzt seinen validierten Pfadvertrag,
Valve-Autorität ihren descriptor-gebundenen Reader.

Zusätzlich delegiert `steam.rs::read_library_folders` ohne eigene Logik an
`scope.rs::read_library_folders`.

### Reduktion

- Ein reiner Parser in `scope.rs` wird von beiden bestehenden Readern genutzt.
- Pfadbasierter Discovery-Read und descriptor-gebundener Valve-Read bleiben
  getrennt.
- Der doppelte Parser in `steam.rs` und der reine Delegationswrapper entfallen.
- `delete_inspect.rs` importiert den bestehenden Scope-Reader direkt.

Erwartung: mindestens 35 aktive Produktionszeilen netto weniger.

### Erhaltene Garantien

- ausschließlich String-Patch-/Token-Parsing; keine VDF-Vollserialisierung.
- Rootblock, numerische Library-Schlüssel, Deduplizierung und leerer-Fallback
  bleiben exakt. Der reine Parser liefert für einen gültigen leeren Block
  immer leer; ausschließlich Discovery ergänzt danach den Steam-Root. Der
  Valve-Reader bleibt im selben Fall leer und erweitert keine Autorität.
- Discovery behält Symlink-, Größen-, Root- und Library-Prüfungen.
- Valve-Autorität behält gebundene Root-, Directory-, Datei- und
  Manifest-Descriptoren.
- Delete-Liveprüfung und Write-Gate-Autorität bleiben fail-closed.

## Verworfene oder vertagte Kandidaten

- Die zwei Live-Inspections, Steam-Checks, Claim-/Restore-Guard und
  Ziel-/Parent-Handles bleiben unverändert.
- `PendingDelete`-Handles von `Option` auf Pflichtfelder zu ändern spart
  Zweige, entfernt aber interne Defense-in-depth-Fehler und erschwert
  Ablauf-/Registry-Fixtures. Kein aktueller Vertrag rechtfertigt das.
- Write-Gate-Enden zusammenzuziehen erzeugt einen neuen Mutationswrapper und
  spart nach Signatur und Parametern keine sicher belegte Mindestmenge.
- Die drei Datei-/Archivdurchläufe bleiben: Streamhash, unabhängiger Diskhash,
  Archivvalidierung und descriptor-gebundene Extraktion erfüllen getrennte
  Garantien.
- Text-/Byte-Read-Helfer behalten verschiedene UTF-8-, Hook- und
  Fehlermeldungsverträge.
- `GeReleaseIdentity.checksum_asset_name` ist redundant, spart allein aber
  nur zwei Produktionszeilen. Kein eigenes Paket.
- Die optionale GE-Environment-Autorität bleibt nach dem Review unverändert;
  ihre sichere Entfernung braucht unverhältnismäßige Command-Testinfrastruktur.
- Reine `?`-Kürzungen in der GE-Pipeline bleiben einem späteren Simplify-Pass
  vorbehalten und dürfen Fehlerpräfixe oder Handle-Lebensdauer nicht ändern.

## Messziel

- Baseline: 13.138 Rust-Zeilen, 238 Tests.
- Abnahme: mindestens 75 aktive Produktionszeilen netto weniger über R3.1 und
  R3.3; jeder Einzelschritt muss seine eigene Mindestwirkung erreichen.
- Ein Paket mit verfehlter Mindestwirkung wird verworfen und nicht durch
  zusätzliche Nebenkürzungen aufgefüllt.

## Abschlussmessung

- R3.1: minus 48 aktive Produktionszeilen; Paketminimum 40 erfüllt.
- R3.3: minus 50 aktive Produktionszeilen; Paketminimum 35 erfüllt.
- Zusammen: minus 98 aktive Produktionszeilen; Gesamtziel 75 erfüllt.
- Gesamt-Rust: 13.138 auf 13.112 Zeilen. Die Testzahl steigt von 238 auf 242,
  weil Parser-, Leerfall-, Descriptor- und Fehlerverträge ergänzt wurden.
- Keine Command-, IPC-, Capability-, Dependency-, UI- oder
  Mutationsreihenfolge geändert.
