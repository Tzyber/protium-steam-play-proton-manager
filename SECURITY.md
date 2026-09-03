# Security Policy

## Supported Versions

Only the latest published Protium release is supported. Older versions do
not receive a blanket support commitment.

| Version | Supported |
|---------|-----------|
| latest (aktuell `v0.7.1`) | ✅ |
| ältere versionen | ❌ keine pauschale supportzusage |

## Reporting a Vulnerability

Protium ist eine lokale desktop-app ohne Protium-server. die app verarbeitet
lokale Steam-Konfigurationen sowie Bibliotheks- und Manifestdaten. der
Config-Write-Pfad kann `config.vdf` und `localconfig.vdf` nach Steam-Check,
Backup und atomarem Rename ändern. Cleanup kann nach Bestätigung Wine-Prefixes
verschieben; sie können lokale Spielstände enthalten. Shader-Caches und
Papierkorb-Einträge können nach Bestätigung endgültig gelöscht werden.

das zentrale threat-model ist der IPC-übergang zwischen Webview und
Rust-Backend.

### read-only-environment

`discover_steam_environment` ist ein no-arg-Backend-Command. Rust löst die
festen Steam-Root-Kandidaten aus dem Backend-Home auf, liest
`libraryfolders.vdf` selbst und ersetzt atomar den aktuellen kanonischen
Environment-Snapshot. Steam-Root, Libraries und System-Compat-Tools sind
danach ausschließlich über snapshotautorisierte Backend-Reads erreichbar.

Die einzigen System-Compat-Wurzeln sind
`/usr/share/steam/compatibilitytools.d` und
`/usr/local/share/steam/compatibilitytools.d`; beliebige Custom-Tool-Wurzeln
oder Webview-Pfadclaims werden nicht akzeptiert. Eine neue Discovery
widerruft die Autorität alter externer Libraries. `exists` liefert nur bei
einem tatsächlichen `NotFound` innerhalb eines aktuellen autorisierten Roots
`false`; ein nicht autorisierter Pfad bleibt ein Fehler.

Die Webview erhält weder statische noch dynamische plugin-fs-Grants auf
Steam-, Library- oder System-Compat-Pfade. Das lokale Steam-Cover-
Asset-Protokoll ist deaktiviert. Cover werden über einen begrenzten,
snapshotautorisierten Binary-Read als Blob-URL geladen und bei Spielwechsel,
Unmount oder verspäteter Antwort widerrufen. AppCache und AppConfig bleiben
separat auf die feste Anwendungsspeicherung beschränkt.

bitte unbekannte lücken zuerst als [privaten GitHub Vulnerability
Report](https://github.com/Tzyber/protium-steam-play-proton-manager/security/advisories/new)
melden. private Vulnerability Reports sind für dieses Repository aktiviert.
öffentliche Issues sind für unbekannte lücken kein primärer Meldeweg; sie
kommen erst nach einem Fix oder nach gemeinsamer Abstimmung infrage.

eine Meldung sollte betroffene version, reproduktionsschritte, betroffene
datei oder command, auswirkung und, falls vorhanden, einen fix-vorschlag
enthalten. bitte keine zugangsdaten oder unnötigen nutzerdaten mitsenden.

bestätigte lücken werden gegen `main` bewertet. wenn eine lücke
release-relevant ist, wird sie mit einem neuen sicherheits- oder
wartungsrelease veröffentlicht. backports für ältere versionen sind nicht
zugesagt.

### Löschautorisierung

Destruktive Cleanup-Aktionen verwenden eine einmalige backendgebundene
Pending-Freigabe. `prepare_delete` und `execute_delete` binden Ziel, Folgen,
Token-TTL, frische Live-Prüfungen und den atomaren Claim an das Rust-Backend.
Die Nutzerbestätigung läuft im Vue-Dialog des Hauptfensters. Er zeigt die aus
`PendingDelete` übernommenen Beschreibungen, ist aber selbst eine Webview-
Darstellung und keine manipulationssichere Vertrauensgrenze. Eine
kompromittierte Webview könnte ein gültiges Token selbst an `execute_delete`
übergeben; Backend-Revalidierung, Claim und Replay-Schutz bleiben die
Sicherheitsgrenzen. Zustandsdrift oder defekte Live-Daten vor dem Claim
beenden den Vorgang ohne Mutation. Tokens verwenden 128 Bit OS-Zufall, haben
60 Sekunden TTL und werden in einer Registry mit maximal 32 aktiven Einträgen
gehalten; bei voller Registry verdrängt ein neues Prepare atomar den ältesten
aktiven Eintrag.

#### Delete-Claim und Restore-Guard

Unmittelbar vor der Mutation benennt `claim_delete_target` das Ziel per
`renameat2(RENAME_NOREPLACE)` auf einen privaten Namen
`.protium-delete-claim-*` um und prüft die Identität des Geclaimten gegen das
autorisierte Ziel. Der Claim ist selbst eine Namespace-Mutation; er macht das
Ziel für Steam unsichtbar und verhindert, dass eine zwischen Prüfung und
Mutation eingeschobene Ersetzung gelöscht wird.

Scheitert nach dem eigenen Claim-Rename etwas — die Identitätsprüfung oder
die nachfolgende Mutation —, versucht ein best-effort Restore-Guard, den
Claim per `RENAME_NOREPLACE` auf den Originalnamen zurückzubenennen. Ist der
Originalname inzwischen wieder belegt, schlägt NOREPLACE fehl und nichts wird
überschrieben; der Claim-Rest bleibt liegen. Der ursprüngliche Fehler wird
nie vom Restore verdeckt.

Liegengebliebene `.protium-delete-claim-*`-Verzeichnisse werden bei späteren
Cleanup-Scans als incomplete deletions sichtbar gemacht — in allen vier
Parent-Locations der Delete-Pipeline: `compatdata`, `shadercache`,
`.protium-trash` und `compatibilitytools.d`. Sie sind keine normalen Orphans
und Protium bietet für sie aktuell keine automatische Restore- oder
Delete-Aktion an.

Es gibt kein separates Confirm-Fenster, keine `confirm_window_*`-Commands und
keine dedizierte Confirm-Capability. `tauri-plugin-dialog` bleibt ausschließlich
für die native Warnbestätigung im GE-Installationspfad ohne Prüfsumme aktiv.

### Neubewertung der Bestätigungsgrenze

Die Webview-Bestätigung wird neu bewertet, sobald externe oder neue Webview-
Inhalte hinzukommen, Capabilities breiter werden, neue IPC-Commands entstehen
oder HTML direkt gerendert wird, etwa über `v-html`, `innerHTML` oder iframes.
Auch eine Lockerung der Navigation-, CSP- oder Backend-Revalidierungsgrenzen
ist ein Auslöser. Bis dahin ist die Webview-Bestätigung als bewusst
akzeptiertes Restrisiko dokumentiert.

### GE-release-identität

Der Rust-Backendtyp `TargetArch` akzeptiert nur `x86_64` und `aarch64`. Der
no-arg-Command `ge_target_arch` normalisiert ausschließlich
`std::env::consts::ARCH`; unbekannte Compile-Architekturen scheitern
fail-closed. Der Store fragt diese Architektur vor dem GitHub-Fetch ab, der
Parser zeigt nur das passende Asset. Der Installationscommand validiert die
Architektur unabhängig erneut, auch bei direktem IPC.

Aktuelle Upstream-Assets heißen exakt
`GE-Proton<version>-x86_64.tar.gz` oder
`GE-Proton<version>-aarch64.tar.gz`. Unsuffixt ist nur die im Snapshot vom
2026-08-20 belegte x86_64-Legacy-Familie bis `GE-Proton11-3`. Das Zielverzeichnis
ist der autorisierte Assetname ohne `.tar.gz`. Download- und SHA512-URL werden
an Tag und Asset gebunden; Query, Fragment, Percent-Encoding und zusätzliche
Pfadsegmente scheitern. Eine Checksum-Zeile muss den exakten Tarballnamen
enthalten. Quelle: offizielle
[Upstream-README](https://github.com/GloriousEggroll/proton-ge-custom/blob/master/README.md).

Der direkte Installations-IPC autorisiert `steam_root` und
`compatibilitytools.d` ausschließlich gegen den aktuellen atomaren
`EnvironmentState`-Snapshot. Discovery, fremde Roots und alte Snapshots
scheitern fail-closed; `app.fs_scope`/Plugin-FS-Authority ist für diesen Pfad
nicht maßgeblich. Precheck und vollständige Extraktionsmutation laufen unter
demselben Snapshot-Guard; eine laufende Discovery wartet, und ein bereits
ersetzter Snapshot lässt keine Mutation zu.

Das Downloadziel entsteht unter Linux als namenloser `O_TMPFILE`-Descriptor über
einen sicher geöffneten, kanonischen AppCache-Directory-FD mit Modus `0600`.
Directory-Symlink und Device-/Inode-Identität werden geprüft. Es gibt keinen
sichtbaren Pfad und keine Unlink-Naht. Streamwrite, SHA512-Hash, Seek und beide
Tar-Pässe verwenden denselben Owned-Handle; zwischen Hash und Extraktion wird
kein Pfad neu geöffnet. Ein fremder gleicher Pfad ist weder Quelle noch
Löschziel. Die SHA512-URL leitet Rust aus Tag und
autorisiertem Asset ab. Nur ein echter HTTP-404 dieses Ziels erlaubt nach
nativer `Warning`-/`OkCancel`-Bestätigung den Status `Unverified`; andere
HTTP-, Netzwerk-, Parse- oder Hashfehler bleiben fail-closed. Cancel weckt
einen blockierten SHA-Abruf aktiv auf und räumt Descriptor sowie Registry auf.

### VDF-Write-Gate und Compat-Tool-Autorität

`save_launch_options` und `save_compat_tool` lesen den Steam-Prozess über
einen synchronen Backend-Leser frisch vor dem VDF-Read/Patch und erneut direkt
vor Backup, temporärer Datei und atomarem Rename. Bei `false, true` entstehen
weder Backup noch Tempdatei; ein byteidentischer No-op beendet den Vorgang vor
dem zweiten Check.

`save_compat_tool` akzeptiert ausschließlich `null`/`default`, einen internen
Namen aus einer nicht-symlinkenden, backendgelesenen `compatibilitytool.vdf`
unter dem Steam-Root oder den zwei kanonischen System-Compat-Wurzeln, oder
einen Namen aus der festen Valve-Tabelle mit Nachweis einer aktuell
installierten Steam-App aus backendgelesenen Manifests. TypeScript-Blocklist,
Scan-Ergebnis und sonstige Webview-Werte autorisieren keinen Write. Leere,
unbekannte, defekte, fehlende oder symlinkende Quellen und nicht installierte
Valve-Apps werden fail-closed abgewiesen.
Die Custom-Quelle wird komponentenweise descriptorgebunden geöffnet: Root und
Toolordner über `openat` mit `O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`, die VDF-Datei
über `openat` mit `O_RDONLY|O_NOFOLLOW|O_CLOEXEC`. `fstat` verlangt eine
reguläre Datei innerhalb des Größenlimits; gelesen und geparst wird aus genau
diesem geöffneten Descriptor. Nicht-Linux verweigert Custom-Autorität
fail-closed. Root-, Toolordner- und VDF-Swap-Races autorisieren keinen fremden
Namen.

Die Config-Reads beider Write-Pfade sind gedeckelt (16 MiB, cap+1-Read,
identisch zur Delete-Pipeline): eine präparierte oder aufgeblähte Config führt
zu einem kontrollierten Fehler vor Backup/Temp/Rename, nie zu einer
Voll-Allokation. Unicode-Control-Characters (NUL, C0, DEL, C1) in
Startoptionen oder Toolnamen lehnt das Backend ab, bevor irgendein Byte
geschrieben wird.

Die Write-Sequenz ist crash-durable: Daten-fsync der Temp-Datei vor dem
atomaren Rename, fsync des Parent-Verzeichnisses danach. Das Backup wird über
no-follow-Deskriptoren geschrieben; sowohl seine Datei als auch der
Verzeichniseintrag und neu angelegte Backup-Verzeichnisse werden synchronisiert.
Bei erfolgreichem Abschluss ist nach einem Stromausfall damit entweder der
alte oder der neue vollständige Stand durable — eine leere/verkürzte Config
durch den Ausfall selbst ist ausgeschlossen. Ein Fehler vor dem Rename meldet,
dass der Write nicht angewendet wurde, und räumt die Temp-Datei auf. Ein
Fehler beim Parent-fsync nach dem Rename meldet ausdrücklich eine mögliche
Mutation; er darf nicht als unveränderter Zielstand behandelt werden.

### Bekannte Einschränkungen und akzeptierte Restrisiken

- **File-Locking & TOCTOU Steam-Start:**
  - *Trigger:* Steam startet exakt im Zeitfenster zwischen der Steam-läuft-Prüfung (`is_process_running`) und dem Schreiben/Umbenennen (`save_launch_options`, `save_compat_tool`).
  - *Wirkung:* Steam überschreibt beim Beenden die von Protium geschriebene Konfiguration. Kein korruptes Dateisystem, da der Schreibvorgang atomar erfolgt (Temp-Datei + Rename) und ein Backup angelegt wurde.
- **Prozess-Substring-Matching:**
  - *Trigger:* Ein fremder Prozess enthält `"steam"` im Namen (z. B. `steam-idle` oder Entwicklungswerkzeuge).
  - *Wirkung:* Protium verweigert vorsorglich Schreib- und Löschoperationen (Fail-Closed False Positive), um Race-Conditions mit echten Steam-Helfern (z. B. `steamwebhelper`) sicher auszuschließen.
- **Upstream-Advisories (Stryker / transitive Dev-Dependencies):**
  - *Trigger:* Bekannte Advisories in Entwicklungs-/Mutations-Testwerkzeugen (z. B. `qs` in `@stryker-mutator/core`).
  - *Wirkung:* Betrifft ausschließlich lokale Testläufe und Build-Pipelines zur Entwicklungszeit, hat keinen Einfluss auf das kompilierte Protium-Binary oder die Laufzeitumgebung der Endanwender.

Fixes und private reproduzierbare Nachweise zu diesen Punkten sind willkommen.
