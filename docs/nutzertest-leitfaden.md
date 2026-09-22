# Leitfaden fuer externe Nutzertests (Protium v1.0)

Dieser Leitfaden richtet sich an Tester von Protium. Ziel ist es, die Stabilitaet, Bedienbarkeit und Barrierefreiheit unter realen Linux-Bedingungen zu pruefen.

## 1. Voraussetzungen

- Betriebssystem: Linux (jede gaengige Distribution mit X11 oder XWayland).
- Steam: Nativ, Flatpak oder Snap installiert.
- Wichtig: Waehrend Protium Schreiboperationen an Konfigurationen vornimmt, muss Steam beendet sein. Protium prueft dies automatisch und verweigert das Schreiben, solange Steam laeuft.

## 2. Testbereiche und Aufgaben

### Bereich A: Erkennung und Scan (Library)
1. Protium starten.
2. Werden alle installierten Steam-Bibliotheken und Spiele korrekt angezeigt?
3. Suche und Filter nutzen: Reagieren Filter und Suche fluessig?
4. Spiel anklicken (Drawer oeffnet sich): Werden Cover, Groesse, ProtonDB-Status und Startoptionen angezeigt?

### Bereich B: Startoptionen und Kompatibilitaet
1. Steam beenden.
2. In den Spieldetails Startoptionen eintragen (z. B. `PROTON_LOG=1 %command%`) und auf "Speichern" klicken.
3. Compat-Tool (z. B. Proton Experimental oder Proton 9) auswaehlen und speichern.
4. "Im Dateimanager oeffnen" fuer das Prefix testen: Oeffnet sich der Wine-Prefix-Ordner im Dateimanager?

### Bereich C: Proton Manager
1. In den Reiter "Proton" wechseln.
2. Wird die Liste der installierten und verfuegbaren GE-Proton Versionen geladen?
3. Eine neue GE-Proton Version herunterladen: Verlaeuft Download, Pruefsummen-Check und Extraktion reibungslos?
4. Download abbrechen testen: Laesst sich der Download sauber ohne Fehlermeldung abbrechen?

### Bereich D: Bereinigung (Cleanup)
1. In den Reiter "Bereinigung" wechseln.
2. Werden verwaiste Prefixes oder Shader-Caches aufgelistet?
3. Pruefen der Erklaerungen ("Warum ist das blockiert?"): Zeigt Protium verstaendliche Gruende an, falls Verzeichnisse nicht beruehrt werden duerfen?
4. Loeschung in den Papierkorb: Erscheint der Sicherheitsdialog mit klarer Auflistung der Folgen?

### Bereich E: Barrierefreiheit und Bedienung
1. Kann die gesamte Oberflaeche nur mit der Tastatur (Tab, Pfeiltasten, Enter, Escape) bedient werden?
2. Sind Fokusrahmen immer deutlich sichtbar?
3. Werden Fehlermeldungen klar und verstaendlich angezeigt?

## 3. Rueckmeldung und Fehlerberichte

Wenn ein Fehler auftritt oder etwas unklar ist:
- Erstelle ein Issue auf GitHub ueber das Template "Nutzertest".
- Bitte nenne deine Distribution, Desktop-Umgebung (GNOME, KDE usw.), Steam-Installationsart (Nativ/Flatpak/Snap) und die genauen Schritte, die zum Verhalten gefuehrt haben.
- Bei Fehlern: Kopiere die angezeigte Fehlermeldung ueber das Kopiersymbol in der Benachrichtigung.
