# Terminologie-Glossar

## Zweck

Dieses Glossar legt die kanonischen Begriffe für lokale Steam-/Proton-Fakten
fest. Es beschreibt Aussage und Grenze jedes Begriffs, ist keine technische
Zustandsmaschine und macht keine zusätzlichen Produktversprechen.

Deutsch ist die Wording-Primärsprache. Die englische Entsprechung ist
verbindlich. Neue Erklärtexte übernehmen die Begriffe und ihre Aussagegrenzen,
ohne sie zu verstärken.

| Deutsch | Englisch | Bedeutet | Bedeutet nicht |
|---|---|---|---|
| explizite Zuordnung | explicit mapping | Steam ordnet diesem Spiel in der Config ein Tool zu | dass dieses Tool beim letzten Start benutzt wurde |
| globaler Standard | global default | Steams voreingestelltes Tool ohne spielspezifische Zuordnung | eine Zuordnung für dieses Spiel |
| keine bekannte Zuordnung | no known explicit mapping | Protium findet keine explizite Zuordnung | dass das Tool ungenutzt ist |
| nicht verfügbar | not available | Protium kann die Information oder das Ergebnis aus der vorgesehenen Quelle im aktuellen Zustand nicht bereitstellen | dass die Quelle nicht existiert oder leer ist |
| nicht gefunden | not found | erwartetes Objekt wurde am belegten Ort nicht gefunden | dass der umgebende Scan vollständig ist |
| unlesbar | unreadable | Quelle existiert, konnte nicht gelesen werden | dass sie leer ist |
| unbekannt | unknown | Protium hat keine Aussage | einen Nullwert |
| nicht gemessen | not measured | Messung nicht durchgeführt, fehlgeschlagen oder nicht sicher darstellbar | 0 Byte |
| unvollständig | incomplete | Ein Teil der Quellen fehlt oder konnte nicht zuverlässig gelesen oder ausgewertet werden | dass das Ergebnis falsch ist |
| Scan-Abdeckung | scan coverage | welche lokalen Quellen dieser Lauf vollständig, teilweise oder nicht lesen konnte | eine allgemeine Systemdiagnose |
| Tool verfügbar | tool available | das zugeordnete Tool wurde in den autorisierten Toolquellen erkannt | dass Steam es beim letzten Start verwendet hat |
| Tool nicht erkannt | tool not recognized | die Config nennt ein Tool, das der aktuelle Scan nicht belegen konnte | dass das Tool definitiv fehlt oder defekt ist |
| bekannt belegt | known footprint | Summe der belegten und erfolgreich gemessenen Spielteile | vollständiger realer Speicherverbrauch |
| Bereinigung blockiert | cleanup blocked | Protium konnte die Löschsicherheit nicht vollständig belegen und bietet keine Mutation an | dass Daten beschädigt sind |
| externer Compatdata-Hinweis | external compatdata hint | Startoptionen enthalten ein konservativ erkanntes `STEAM_COMPAT_DATA_PATH`-Muster | dass Protium den externen Pfad gelesen oder validiert hat |
| verwaist | orphaned | Daten ohne zugehörige Installation | dass sie wertlos sind |
| steam-eigen | steam-owned | gehört zu einem Steam-Paket, nicht zu einem Spiel | dass es nicht gelöscht werden kann |
| abgebrochene Löschung | incomplete deletion | Protium hat umbenannt und nicht abgeschlossen | dass die Daten weg sind |
| aus Sicherheitsgründen blockiert | blocked for safety | Protium konnte die Lage nicht sicher prüfen | dass ein Fehler vorliegt |
| Startoptionen-Hinweis | launch options hint | Ein enges statisches Muster ist auffällig | dass die Startoption sicher falsch ist |
| Proton-Logging im Entwurf aktiv | Proton logging enabled in draft | der aktuelle Startoptionen-Entwurf enthält ein eng erkanntes `PROTON_LOG=1` vor `%command%` | dass der Entwurf gespeichert ist, eine Logdatei existiert oder weiter wächst |
| Prefix-Formatstand | prefix format state | interner Wert aus einer belegten Prefix-Metadatei | welches Tool zuletzt gestartet wurde |
| ProtonDB-Tier | ProtonDB tier | aggregierter Community-Befund | kein lokaler Test |
| vollständig | complete | alle vorgesehenen Scanquellen dieses Laufs verarbeitet | keine Vollsystem-Garantie |
| eingeschränkt | limited | fehlende oder mehrdeutig gewählte Config bei sonst auswertbaren Quellen | nicht identisch mit Lesefehlern |
| vorhandener Anzeigestand | existing displayed state | gespeicherte UI-Beobachtungen ohne zugesicherte Aktualität oder vollständige Prüfung | dass die Beobachtung im aktuellen Scan bestätigt wurde |
| gemessen | measured | Größenwert aus einer abgeschlossenen lokalen Größenmessung | dass der Wert nach späteren Dateisystemänderungen noch aktuell ist |
| Existenzprüfung | existence check | eine vorgesehene lokale Prüfung hat Existenz oder Fehlen eines Objekts am autorisierten Ort belegt | dass bei vorhandenem Objekt seine Größe gemessen wurde |
| lokale Messung und Existenzprüfung | local measurement and existence check | die Speicherzusammenfassung verwendet gemessene Werte und gegebenenfalls belegtes Fehlen mit 0 Byte | dass alle Spielbestandteile bekannt oder gemessen sind |
| Prüfung läuft | check in progress | die angeforderte lokale Prüfung ist noch nicht abgeschlossen | dass ein bereits sichtbares Teilergebnis vollständig ist |
| mehrdeutig | ambiguous | die gelesenen Quellen erlauben keine eindeutige Auswahl der Launch-Config | dass eine bestimmte Config gewählt oder ihr Inhalt analysiert wurde |
| verfügbar | available | die vorgesehene Quelle konnte im aktuellen Scan bereitgestellt und ausgewertet werden | dass sie beim letzten Spielstart wirksam war |
| teilweise | partial | die angezeigte Summe enthält nur die sicher belegten Teilwerte | dass fehlende Teilwerte 0 Byte sind |

## Änderungsvertrag

Ab v0.8.0 braucht jeder neue UI-Wahrheitszustand vor seiner Verwendung einen
Glossareintrag in deutscher und englischer Fassung. Bestehende UI-Texte werden
durch dieses Artefakt nicht global umformuliert.
