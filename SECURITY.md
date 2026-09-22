# Security Policy

## Supported Versions

Only the latest published Protium release is supported. Older versions do
not receive a blanket support commitment.

| Version | Supported |
|---------|-----------|
| jeweils die letzte veröffentlichte Version | ✅ |
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

### Prefix-Ordner im Dateimanager öffnen

`open_prefix_folder` nimmt genau `library` und `appId`, keinen Zielpfad. Die
Library muss zum kanonischen Environment-Snapshot gehören, der bis zum
Handlerstart gesperrt bleibt; die Identität des geöffneten Library-Deskriptors
muss zum vorher erfassten Gerät/Inode passen. Manifest und Prefix-Kette laufen
über denselben `steamapps`-Deskriptor; `compatdata`, AppID und `pfx` werden mit
`O_NOFOLLOW` geöffnet. Der Name des Prefix-Deskriptors wird aus `/proc/self/fd`
zurückgelesen und muss absolut, NUL-frei, unterhalb der Library und ohne
` (deleted)`-Suffix sein. Erst dann erhält `xdg-open`, ersatzweise `gio open`,
den Namen als einzelnes `OsStr`-Argument ohne Shell. Keine neue Capability.

Das Backend antwortet nur mit `blocked`, `not-found`, `unreadable` oder
`handler-unavailable`; die UI ergänzt `external-target` und `unchecked` und
zeigt feste de/en-Texte, nie Pfade oder Rohtext. Die UI sperrt bei nicht
eindeutig verfügbaren Startoptionen, laufendem Scan und jedem Vorkommen von
`STEAM_COMPAT_DATA_PATH`; das Gatter ist konservativ, keine Backend-Autorität.
Dieselbe konservative Erkennung lässt auch den Compatdata-Teil der
Speicherbedarfsmessung ungemessen, weil das Standardziel dann nicht belegt ist.

**Verbleibende Grenze:** Der Dateimanager erhält einen Pfad und löst ihn selbst
erneut auf. Ein Prozess mit Schreibrecht auf eine Pfadkomponente kann sie
zwischen Prüfung und Auflösung austauschen; ein Test hält diese Grenze fest,
ohne sie zu schließen. Protium schreibt, verschiebt oder löscht dabei nichts.
Der gestartete Dateimanager läuft mit Nutzerrechten weiter und kann selbst
Daten verändern. „Dateimanager gestartet“ bestätigt nur den Prozessstart.

### VDF-Lesepfad (Textdateien)

Von Protium gelesene Text-VDF-Dateien (Manifeste, `config.vdf`,
`localconfig.vdf`, Tool-VDFs) werden mit `@node-steam/vdf` geparst. Die
Bibliothek weist Keys ungefiltert zu und kann dabei den globalen JavaScript-
Zustand mutieren. Zwei Schichten verhindern das: Ein Pre-Pass neutralisiert
Block-Keys, die auf `__proto__`, `constructor`, `prototype` oder auf ein
geerbtes Mitglied von `Object.prototype` zeigen (auch hinter
Steam-Conditionals und in unquotierter Form); zusätzlich liegt um den Parse
ein Containment, das `Object.prototype`, `Object` und die darin hängenden
Objekte und Funktionen vorher festhält und nach dem Parse exakt zurücksetzt.
Der Pre-Pass bildet die zeilenweise Grammatik der Bibliothek nicht
vollständig ab; das Containment ist davon unabhängig und deckt die
gemessenen Umgehungsformen ab (elf Eingabeformen sind als Regressionstest
festgehalten). Der Nutzen des Containments hängt nicht daran, dass der
Pre-Pass jede Form kennt.

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
300 Sekunden TTL und werden in einer Registry mit maximal 32 aktiven Einträgen
gehalten; bei voller Registry verdrängt ein neues Prepare atomar den ältesten
aktiven Eintrag.

#### Delete-Claim und Restore-Guard

Unmittelbar vor der Mutation benennt `claim_delete_target` das Ziel per
`renameat2(RENAME_NOREPLACE)` auf einen privaten Namen
`.protium-delete-claim-*` um und prüft die Identität des Geclaimten gegen das
autorisierte Ziel. Der Claim ist selbst eine Namespace-Mutation; er macht das
Ziel für Steam unsichtbar und verhindert, dass eine zwischen Prüfung und
Mutation eingeschobene Ersetzung gelöscht wird.

Scheitert nach dem eigenen Claim-Rename etwas (die Identitätsprüfung oder
die nachfolgende Mutation), versucht ein best-effort Restore-Guard, den
Claim per `RENAME_NOREPLACE` auf den Originalnamen zurückzubenennen. Ist der
Originalname inzwischen wieder belegt, schlägt NOREPLACE fehl und nichts wird
überschrieben; der Claim-Rest bleibt liegen. Der ursprüngliche Fehler wird
nie vom Restore verdeckt.

Liegengebliebene `.protium-delete-claim-*`-Verzeichnisse werden bei späteren
Cleanup-Scans als incomplete deletions sichtbar gemacht, in allen vier
Parent-Locations der Delete-Pipeline: `compatdata`, `shadercache`,
`.protium-trash` und `compatibilitytools.d`. Sie sind keine normalen Orphans
und Protium bietet für sie aktuell keine automatische Restore- oder
Delete-Aktion an.

Es gibt kein separates Confirm-Fenster, keine `confirm_window_*`-Commands und
keine dedizierte Confirm-Capability. `tauri-plugin-dialog` bleibt ausschließlich
für die native Warnbestätigung im GE-Installationspfad ohne Prüfsumme aktiv.

`prepare_delete` bindet den angeforderten `steam_root` exakt an
`snapshot.steam_root`. Ein autorisierter Nachbarpfad (etwa eine externe
Library) wird abgelehnt, bevor die Inspektion läuft: sonst läse sie
`userdata` unter einem fremden Verzeichnis und hielte einen echten Shortcut
für eine Waise. Die Ablehnungen der Live-Inspektion (kein verwaister Eintrag,
Library nicht gelistet, Tool nicht verwaltet) tragen kanonische Fehlercodes;
die Oberfläche zeigt übersetzten Text, das englische Detail bleibt im
Protokoll.

Das Papierkorb-Ziel `<library>/steamapps/.protium-trash` entsteht ebenfalls
entlang gebundener Deskriptoren: Die Library wird identitätsgeprüft geöffnet,
`steamapps` und der Papierkorb folgen relativ dazu mit `O_NOFOLLOW`, und die
Verschiebung nutzt `renameat2(RENAME_NOREPLACE)` mit dem gebundenen
Quell-Handle. Ein ausgetauschter Parent kann den Papierkorb damit nicht
außerhalb der autorisierten Library anlegen.

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
einen synchronen Backend-Leser frisch vor dem VDF-Read/Patch, ein zweites Mal
vor Backup und Temp-Anlage und ein drittes Mal nach dem Daten-fsync der
Temp-Datei, unmittelbar vor dem `renameat`. Bei `false, true` entstehen weder
Backup noch Tempdatei; ein byteidentischer No-op beendet den Vorgang vor dem
zweiten Check. Zwischen der letzten Prüfung und dem Rename bleibt ein Fenster
von wenigen Mikrosekunden. Es ist nicht ausgeschlossen, aber durch die dritte
Prüfung so klein wie technisch möglich; eine Atomizität über den ganzen
Vorgang behauptet Protium nicht.

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

Die Write-Sequenz ist descriptorgebunden und crash-durable: Der
Parent-Deskriptor des Ziels wird identitätsgeprüft geöffnet
(`O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`, dev/ino-Vergleich vor und nach dem Open).
Die Temp-Datei entsteht relativ zu diesem Deskriptor mit
`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC`, der Rename läuft per
`renameat` auf denselben Deskriptor, und der Parent-fsync nutzt genau diesen
Deskriptor. Ein vorhandener Symlink oder eine vorbereitete Temp-Datei wird
damit weder gefolgt noch truncatet; ein ausgetauschter Parent lässt den
Vorgang fail-closed enden. Die Daten werden vor dem Rename gefsynct, das
Parent-Verzeichnis danach. Das Backup wird ebenfalls über
no-follow-Deskriptoren geschrieben; sowohl seine Datei als auch der
Verzeichniseintrag und neu angelegte Backup-Verzeichnisse werden synchronisiert.
Bei erfolgreichem Abschluss ist nach einem Stromausfall damit entweder der
alte oder der neue vollständige Stand durable; eine leere oder verkürzte
Config durch den Ausfall selbst ist ausgeschlossen. Ein Fehler vor dem Rename meldet,
dass der Write nicht angewendet wurde, und räumt die Temp-Datei auf. Ein
Fehler beim Parent-fsync nach dem Rename meldet ausdrücklich eine mögliche
Mutation; er darf nicht als unveränderter Zielstand behandelt werden.

### Export-Allowlist und Zwischenablage

„Technische infos kopieren" exportiert feste Labels, Status-Enums, validierte
nichtnegative Zahlen, die Paketversion und berichtsbezogene Aliase
(`<steam-library-N>`, `<compat-tool-1>`). Zugeordnete Toolnamen werden im Core
über zwei lokale Regeln freigegeben:

- `BLOCKLIST` in `src/core/blocklist.ts`: Der erste Eintrag der Kategorie
  `proton-builtin` mit exakt passendem internem `toolName` liefert sein festes
  `label`. `proton_11` ergibt „Proton 11.0“, ohne Architekturannahme.
- `MANAGED_GE_NAME_RE` in `src/core/geproton.ts`: Ein vollständiger Treffer
  erlaubt den GE-Namen unverändert. Das Muster begrenzt die Form, belegt aber
  weder Herkunft, veröffentlichtes Release noch Installation. Auch selbst
  benannte Tools und Kennungen innerhalb der Ziffernsegmente können passen;
  der Beleg ist deshalb datensparsam, nicht garantiert anonym.

Übrige gültige Toolnamen erscheinen als `<compat-tool-1>`, unbekannte
Zuordnungen bleiben unbekannt. Gelesene Anzeigenamen sind keine Ausgabequelle.
Spiel- und Manifestnamen, Pfade, Config-Inhalte/Startoptionen, Warning-/Error-
Details, Confidence und Bilder-URLs werden nicht in den Beleg übernommen.
Es gibt keinen Rohdatenexport über IPC und keinen Clipboard-Lesezugriff.
Der Write läuft über das vorhandene Browser-`writeText` ohne neue Capability
oder Plugin. Ungültige Werte erscheinen als „unbekannt", nie als 0, NaN oder
Infinity.

Abbruchgrenze: Ein einmal gestarteter Clipboard-Write ist nicht rückholbar.
Die Zwischenablage kann den beim Klick gebildeten, datensparsamen
Beleg enthalten; es gibt kein Rollback, keine Wiederholung und keine
automatische Löschung der Zwischenablage. Fehlende Clipboard-API und
Write-Fehler zeigen ausschließlich eine generische lokalisierte Meldung, nie
eine rohe Exception.

### Release-Integrität

Ein Release entsteht aus einem Tag-Push. Der Workflow baut AppImage und deb,
patcht die AppImage (Wayland/EGL) und lädt beide Artefakte plus `SHA256SUMS`
in einen Draft; veröffentlicht wird der Draft von Hand. Die folgenden
Prüfwege gelten ab dem ersten Release mit `SHA256SUMS`; die Releases bis
`v0.9.2` haben weder Summendatei, noch Attestation, noch Signatur.

- **Checksummen:** `sha256sum -c SHA256SUMS` prüft die Integrität des
  Downloads. Die Datei gehört zum selben Asset-Satz wie die Artefakte.
- **GPG-Signatur:** `gpg --verify SHA256SUMS.asc SHA256SUMS` prüft die
  Signatur des Projektschlüssels `08C084ECC83DFDB10E5CF60A8B2CA074A44AC4FA`
  (Signing-Subkey `1826455C6A359EDD`, Ablauf 2028-09-15). Der öffentliche
  Schlüssel liegt als `docs/protium-release-key.asc` im Repository und auf
  keys.openpgp.org, dort unter der bestätigten Adresse
  `mail@dominik-webdeveloper.com` auffindbar. Signiert wird lokal; der private
  Schlüssel liegt weder im Repository noch in der CI. Der Ablauf ist bewusst
  zweistufig: der Workflow erzeugt `SHA256SUMS` im Draft, die Signatur
  `SHA256SUMS.asc` entsteht danach auf dem Rechner des Maintainers und wird
  vor dem Veröffentlichen in den Draft gelegt. Fehlt sie, ist der Draft noch
  nicht veröffentlichungsreif.
- **Provenienz:** `gh attestation verify <datei> --repo <owner/repo>` prüft
  die Build-Attestation. Sie bindet den Digest an Repository, Workflow und
  Commit (SLSA Build Level 2), nicht an eine Person.
- **Grenze:** Checksummen und Attestation beweisen weder Gutartigkeit noch
  Vertrauenswürdigkeit des Autors. Der Vertrauensanker der Attestation ist der
  Workflow am Tag: wer Schreibzugriff auf Repository und Tag hat, kann eine
  passende Attestation und eine passende `SHA256SUMS` erzeugen. Auch die
  Repository-URL im Prüfbefehl muss deshalb aus einem zweiten Kanal kommen.
  Die GPG-Signatur ist der einzige von GitHub unabhängige Herkunftsnachweis,
  taugt aber nur so viel wie die Bestätigung des Fingerprints über einen
  zweiten Kanal; ohne sie bleibt es TOFU.
- **Tag-Herkunft und Gate-Umfang:** Der Workflow prüft in einem eigenen Job,
  dass der Tag-Commit auf `origin/main` liegt; jeder `v*`-Tag startete sonst
  einen Release aus einem beliebigen Stand. Dass die vollständige CI zum selben
  Commit grün war, bleibt prozessual und wird nicht automatisch erzwungen.
  `bench:gate` und der Mutationslauf laufen nur in der CI: das Bench-Gate ist
  maschinengebunden und der Mutationslauf dauert ein Vielfaches des Builds.

### Bekannte Einschränkungen und akzeptierte Restrisiken

- **File-Locking & TOCTOU Steam-Start:**
  - *Trigger:* Steam startet exakt im Zeitfenster zwischen der letzten Steam-läuft-Prüfung (unmittelbar vor dem `renameat`) und dem Umbenennen selbst.
  - *Wirkung:* Steam überschreibt beim Beenden die von Protium geschriebene Konfiguration. Kein korruptes Dateisystem, da der Schreibvorgang atomar erfolgt (Temp-Datei + Rename) und ein Backup angelegt wurde.
- **Prozess-Substring-Matching:**
  - *Trigger:* Ein fremder Prozess enthält `"steam"` im Namen (z. B. `steam-idle` oder Entwicklungswerkzeuge).
  - *Wirkung:* Protium verweigert vorsorglich Schreib- und Löschoperationen (Fail-Closed False Positive), um Race-Conditions mit echten Steam-Helfern (z. B. `steamwebhelper`) sicher auszuschließen.
- **Upstream-Advisories (Stryker / transitive Dev-Dependencies):**
  - *Trigger:* Bekannte Advisories in Entwicklungs-/Mutations-Testwerkzeugen (z. B. `qs` in `@stryker-mutator/core`).
  - *Wirkung:* Betrifft ausschließlich lokale Testläufe und Build-Pipelines zur Entwicklungszeit, hat keinen Einfluss auf das kompilierte Protium-Binary oder die Laufzeitumgebung der Endanwender.
- **Lokales Diagnoseprotokoll:**
  - *Trigger:* Fehlertexte des Backends werden in `$APPLOCALDATA/logs` protokolliert; der Nutzer kann den Ordner über die Oberfläche öffnen und die Datei weitergeben.
  - *Wirkung:* Das Protokoll ist lokal und enthält bewusst die rohe Backend-Meldung samt Fehlercode (die Oberfläche zeigt nur übersetzten Text). Das Backend ersetzt darin Home-Pfade durch `~`; absolute Pfade außerhalb des Home-Verzeichnisses können dennoch vorkommen. Wer das Protokoll weitergibt, gibt damit eigene Pfade weiter.

Fixes und private reproduzierbare Nachweise zu diesen Punkten sind willkommen.
