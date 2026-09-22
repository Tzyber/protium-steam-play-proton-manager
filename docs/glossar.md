# Terminologie-Glossar

## Zweck

Dieses Glossar legt die kanonischen Begriffe für lokale Steam-/Proton-Fakten
fest. Es beschreibt, was ein Begriff aussagt, ist keine technische
Zustandsmaschine und macht keine zusätzlichen Produktversprechen.

Deutsch ist die Wording-Primärsprache. Die englische Entsprechung ist
verbindlich. Erklärtexte verwenden diese Begriffe wörtlich.

## Begriffe

| Deutsch | Englisch | Bedeutet |
|---|---|---|
| explizite Zuordnung | explicit mapping | Steam ordnet diesem Spiel in der Config ein Tool zu |
| globaler Standard | global default | Steams voreingestelltes Tool ohne spielspezifische Zuordnung |
| keine bekannte Zuordnung | no known explicit mapping | Protium findet keine explizite Zuordnung |
| nicht verfügbar | not available | Protium kann die Information oder das Ergebnis aus der vorgesehenen Quelle im aktuellen Zustand nicht bereitstellen |
| nicht gefunden | not found | erwartetes Objekt wurde am belegten Ort nicht gefunden |
| unlesbar | unreadable | Quelle existiert, konnte nicht gelesen werden |
| unbekannt | unknown | Protium hat keine Aussage |
| nicht gemessen | not measured | Messung nicht durchgeführt, fehlgeschlagen oder nicht sicher darstellbar |
| unvollständig | incomplete | Ein Teil der Quellen fehlt oder konnte nicht zuverlässig gelesen oder ausgewertet werden |
| Scan-Abdeckung | scan coverage | welche lokalen Quellen dieser Lauf vollständig, teilweise oder nicht lesen konnte |
| Tool verfügbar | tool available | das zugeordnete Tool wurde in den autorisierten Toolquellen erkannt |
| Tool nicht erkannt | tool not recognized | die Config nennt ein Tool, das der aktuelle Scan nicht belegen konnte |
| bekannt belegt | known footprint | Summe der belegten und erfolgreich gemessenen Spielteile |
| Bereinigung blockiert | cleanup blocked | Protium konnte die Löschsicherheit nicht vollständig belegen und bietet keine Mutation an |
| externer Compatdata-Hinweis | external compatdata hint | Startoptionen enthalten ein konservativ erkanntes `STEAM_COMPAT_DATA_PATH`-Muster |
| verwaist | orphaned | Daten ohne zugehörige Installation |
| steam-eigen | steam-owned | gehört zu einem Steam-Paket, nicht zu einem Spiel |
| abgebrochene Löschung | incomplete deletion | Protium hat umbenannt und nicht abgeschlossen |
| aus Sicherheitsgründen blockiert | blocked for safety | Protium konnte die Lage nicht sicher prüfen |
| Startoptionen-Hinweis | launch options hint | ein enges statisches Muster ist auffällig |
| Proton-Logging im Entwurf aktiv | Proton logging enabled in draft | der aktuelle Startoptionen-Entwurf enthält ein eng erkanntes `PROTON_LOG=1` vor `%command%` |
| Prefix-Formatstand | prefix format state | interner Wert aus einer belegten Prefix-Metadatei |
| ProtonDB-Tier | ProtonDB tier | aggregierter Community-Befund |
| vollständig | complete | alle vorgesehenen Scanquellen dieses Laufs verarbeitet |
| eingeschränkt | limited | fehlende oder mehrdeutig gewählte Config bei sonst auswertbaren Quellen |
| vorhandener Anzeigestand | existing displayed state | gespeicherte UI-Beobachtungen ohne zugesicherte Aktualität oder vollständige Prüfung |
| gemessen | measured | Größenwert aus einer abgeschlossenen lokalen Größenmessung |
| Existenzprüfung | existence check | eine vorgesehene lokale Prüfung hat Existenz oder Fehlen eines Objekts am autorisierten Ort belegt |
| lokale Messung und Existenzprüfung | local measurement and existence check | die Speicherzusammenfassung verwendet gemessene Werte und gegebenenfalls belegtes Fehlen mit 0 Byte |
| Prüfung läuft | check in progress | die angeforderte lokale Prüfung ist noch nicht abgeschlossen |
| mehrdeutig | ambiguous | die gelesenen Quellen erlauben keine eindeutige Auswahl der Launch-Config |
| verfügbar | available | die vorgesehene Quelle konnte im aktuellen Scan bereitgestellt und ausgewertet werden |
| teilweise | partial | die angezeigte Summe enthält nur die sicher belegten Teilwerte |
| Claim-Prüfung | claim check | die Prüfung der Orte, an denen Protium abgebrochene Löschungen erkennt |
| Bereinigungsfreigabe | cleanup clearance | im vorhandenen Anzeigestand ist für keinen Bereich eine Blockade vermerkt |
| Prefix-Ordner | prefix folder | der von Steam angelegte Wine-Prefix eines Spiels unter `compatdata/<AppID>/pfx` |
| Löschumfang einer Compat-Tool-Entfernung | compat tool removal scope | entfernt wird das Tool-Verzeichnis |
| Dateimanager gestartet | file manager launched | Protium hat den Systemhandler mit dem geprüften Ordner gestartet |

## Änderungsvertrag

Ab v0.8.0 braucht jeder neue UI-Wahrheitszustand vor seiner Verwendung einen
Glossareintrag in deutscher und englischer Fassung. Bestehende UI-Texte werden
durch dieses Artefakt nicht global umformuliert.

Entscheidung 2026-09-18, nachgezogen am 2026-09-22: Die frühere vierte Spalte
„Bedeutet nicht" entfällt. Die Erklärungen nennen Quelle und Bedeutung eines
Werts; die Abgrenzung gehört in die Formulierung des Begriffs selbst, nicht in
eine eigene Liste.
