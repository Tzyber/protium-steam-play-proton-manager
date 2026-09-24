// Glossar-spiegel der Erklär-Themen: die Paare (de, en) waren nie Teil der
// Laufzeit-Anzeige, sondern dienten nur dem Doku-Spiegeltest. Als Fixture liegt
// das Wissen beim Test statt im Produktionscode (U-17).

import type { ExplainTopic } from "../../src/ui/explain.js";

export interface ExplainGlossaryAnchor {
  readonly de: string;
  readonly en: string;
}

export const EXPLAIN_GLOSSARY = {
  "explicit-mapping-count": [
    { de: "explizite Zuordnung", en: "explicit mapping" },
    { de: "globaler Standard", en: "global default" },
    { de: "keine bekannte Zuordnung", en: "no known explicit mapping" },
  ],
  "ge-delete-scope": [
    { de: "Löschumfang einer Compat-Tool-Entfernung", en: "compat tool removal scope" },
    { de: "Prefix-Ordner", en: "prefix folder" },
  ],
  "compat-tool": [{ de: "Tool verfügbar", en: "tool available" }],
  "compat-source": [
    { de: "explizite Zuordnung", en: "explicit mapping" },
    { de: "globaler Standard", en: "global default" },
    { de: "nicht verfügbar", en: "not available" },
  ],
  "global-default": [{ de: "globaler Standard", en: "global default" }],
  "config-unavailable": [
    { de: "nicht verfügbar", en: "not available" },
    { de: "nicht gefunden", en: "not found" },
    { de: "unlesbar", en: "unreadable" },
  ],
  protondb: [
    { de: "ProtonDB-Tier", en: "ProtonDB tier" },
    { de: "unbekannt", en: "unknown" },
  ],
  "scan-coverage": [
    { de: "Scan-Abdeckung", en: "scan coverage" },
    { de: "vollständig", en: "complete" },
    { de: "eingeschränkt", en: "limited" },
    { de: "unvollständig", en: "incomplete" },
  ],
  "tool-unrecognized": [{ de: "Tool nicht erkannt", en: "tool not recognized" }],
  footprint: [
    { de: "bekannt belegt", en: "known footprint" },
    { de: "nicht gemessen", en: "not measured" },
    { de: "gemessen", en: "measured" },
    { de: "Existenzprüfung", en: "existence check" },
    { de: "lokale Messung und Existenzprüfung", en: "local measurement and existence check" },
    { de: "teilweise", en: "partial" },
  ],
  "external-compatdata": [{ de: "externer Compatdata-Hinweis", en: "external compatdata hint" }],
  "cleanup-blocked": [
    { de: "Bereinigung blockiert", en: "cleanup blocked" },
    { de: "vorhandener Anzeigestand", en: "existing displayed state" },
  ],
  "steam-owned": [
    { de: "steam-eigen", en: "steam-owned" },
    { de: "vorhandener Anzeigestand", en: "existing displayed state" },
  ],
  "incomplete-deletion": [
    { de: "abgebrochene Löschung", en: "incomplete deletion" },
    { de: "vorhandener Anzeigestand", en: "existing displayed state" },
  ],
} as const satisfies Readonly<Record<ExplainTopic, readonly ExplainGlossaryAnchor[]>>;
