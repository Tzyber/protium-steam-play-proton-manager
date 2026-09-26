// Grammatik des lokalen Protokolls ("[<sekunden>] [LEVEL] text"), wie sie das
// Backend schreibt. Die Zerlegung ist UI-frei und liegt deshalb im Kern; die
// Ansicht formatiert die Sekunden nur noch in die aktive Sprache.

interface LogRecord {
  /** Sekunden seit Prozessstart, `null` wenn die Zeile keine Zeitmarke trägt. */
  seconds: number | null;
  level: string;
  message: string;
}

const LOG_LINE_RE = /^\[(\d+)\] \[(\w+)\] ?([\s\S]*)$/;

/** Zerlegt eine Protokollzeile; eine unbekannte Form bleibt als nackte Nachricht. */
export function parseLogRecord(line: string): LogRecord {
  const match = LOG_LINE_RE.exec(line);
  if (match === null) return { seconds: null, level: "", message: line };
  const seconds = Number.parseInt(match[1] ?? "", 10);
  return {
    seconds: Number.isFinite(seconds) ? seconds : null,
    level: (match[2] ?? "").toLowerCase(),
    message: match[3] ?? "",
  };
}
