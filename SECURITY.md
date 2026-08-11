# Security Policy

## Supported Versions

Protium ist noch nicht released. Sicherheits-updates gibt es bis zum ersten
stable release nur auf `main`.

| Version | Supported |
|---------|-----------|
| main    | ✅ |
| < 1.0   | ❌ |

## Reporting a Vulnerability

Protium ist eine lokale desktop-app — kein server, keine api-keys, keine
nutzerdaten. das threat-model ist der IPC-übergang zwischen webview und
rust-backend.

Fund bitte per [github-issue](https://github.com/Tzyber/protium-steam-play-proton-manager/issues/new)
melden, nicht per mail. beschreibung mit schritten zum reproduzieren, betroffener
datei/command und vorgeschlagener abhilfe.

- **antwort:** innerhalb von 7 tagen
- **status-updates:** im issue
- **ablehnung:** mit begründung (z. b. „single-user-desktop, im threat-model
  nicht abgedeckt")
- **fix:** patch auf main, kein backport (keine releases)

### bekannte restriktionen

- **file-locking:** kein advisory lock um den read-modify-write-zyklus beim
  schreiben von steam-konfigurationsdateien. steam kann zwischen check und
  `rename` starten → write wird beim steam-exit überschrieben.
- **TOCTOU steam-start:** das fenster zwischen steam-läuft-check und write ist
  nicht atomar. abhilfe bräuchte rust-seitiges `flock`.
- **download-size-limit (8 GiB cap + stall-timeout):** disk-exhaustion-schutz
  vorhanden, kein streaming-budget.

diese punkte sind dokumentiert, nicht vergessen. fixes willkommen.
