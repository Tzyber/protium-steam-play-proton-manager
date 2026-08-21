// Steam-Write-Gate: Fehlerklassen für Steam-Konfigurationsänderungen.

export class SteamRunningError extends Error {
  constructor() {
    super(
      "steam läuft gerade, die änderung würde beim beenden überschrieben. bitte steam erst beenden.",
    );
    this.name = "SteamRunningError";
  }
}
