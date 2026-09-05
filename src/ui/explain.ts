import type { Key } from "./i18n/index.js";

export type ExplainTopic =
  | "compat-tool"
  | "compat-source"
  | "global-default"
  | "config-unavailable"
  | "protondb"
  | "scan-coverage"
  | "tool-unrecognized"
  | "footprint"
  | "external-compatdata"
  | "cleanup-blocked"
  | "steam-owned"
  | "incomplete-deletion";

export interface ExplainGlossaryAnchor {
  readonly de: string;
  readonly en: string;
}

export interface ExplainTopicDefinition {
  readonly titleKey: Key;
  readonly sourceKey: Key;
  readonly meaningKey: Key;
  readonly limitKey: Key;
  readonly glossary: readonly ExplainGlossaryAnchor[];
}

export const EXPLAIN_TOPICS = {
  "compat-tool": {
    titleKey: "explain.topics.compatTool.title",
    sourceKey: "explain.topics.compatTool.source",
    meaningKey: "explain.topics.compatTool.meaning",
    limitKey: "explain.topics.compatTool.limit",
    glossary: [{ de: "Tool verfügbar", en: "tool available" }],
  },
  "compat-source": {
    titleKey: "explain.topics.compatSource.title",
    sourceKey: "explain.topics.compatSource.source",
    meaningKey: "explain.topics.compatSource.meaning",
    limitKey: "explain.topics.compatSource.limit",
    glossary: [
      { de: "explizite Zuordnung", en: "explicit mapping" },
      { de: "globaler Standard", en: "global default" },
      { de: "nicht verfügbar", en: "not available" },
    ],
  },
  "global-default": {
    titleKey: "explain.topics.globalDefault.title",
    sourceKey: "explain.topics.globalDefault.source",
    meaningKey: "explain.topics.globalDefault.meaning",
    limitKey: "explain.topics.globalDefault.limit",
    glossary: [{ de: "globaler Standard", en: "global default" }],
  },
  "config-unavailable": {
    titleKey: "explain.topics.configUnavailable.title",
    sourceKey: "explain.topics.configUnavailable.source",
    meaningKey: "explain.topics.configUnavailable.meaning",
    limitKey: "explain.topics.configUnavailable.limit",
    glossary: [
      { de: "nicht verfügbar", en: "not available" },
      { de: "nicht gefunden", en: "not found" },
      { de: "unlesbar", en: "unreadable" },
    ],
  },
  protondb: {
    titleKey: "explain.topics.protondb.title",
    sourceKey: "explain.topics.protondb.source",
    meaningKey: "explain.topics.protondb.meaning",
    limitKey: "explain.topics.protondb.limit",
    glossary: [
      { de: "ProtonDB-Tier", en: "ProtonDB tier" },
      { de: "unbekannt", en: "unknown" },
    ],
  },
  "scan-coverage": {
    titleKey: "explain.topics.scanCoverage.title",
    sourceKey: "explain.topics.scanCoverage.source",
    meaningKey: "explain.topics.scanCoverage.meaning",
    limitKey: "explain.topics.scanCoverage.limit",
    glossary: [
      { de: "Scan-Abdeckung", en: "scan coverage" },
      { de: "vollständig", en: "complete" },
      { de: "eingeschränkt", en: "limited" },
      { de: "unvollständig", en: "incomplete" },
    ],
  },
  "tool-unrecognized": {
    titleKey: "explain.topics.toolUnrecognized.title",
    sourceKey: "explain.topics.toolUnrecognized.source",
    meaningKey: "explain.topics.toolUnrecognized.meaning",
    limitKey: "explain.topics.toolUnrecognized.limit",
    glossary: [{ de: "Tool nicht erkannt", en: "tool not recognized" }],
  },
  footprint: {
    titleKey: "explain.topics.footprint.title",
    sourceKey: "explain.topics.footprint.source",
    meaningKey: "explain.topics.footprint.meaning",
    limitKey: "explain.topics.footprint.limit",
    glossary: [
      { de: "bekannt belegt", en: "known footprint" },
      { de: "nicht gemessen", en: "not measured" },
      { de: "gemessen", en: "measured" },
      { de: "Existenzprüfung", en: "existence check" },
      {
        de: "lokale Messung und Existenzprüfung",
        en: "local measurement and existence check",
      },
      { de: "teilweise", en: "partial" },
    ],
  },
  "external-compatdata": {
    titleKey: "explain.topics.externalCompatdata.title",
    sourceKey: "explain.topics.externalCompatdata.source",
    meaningKey: "explain.topics.externalCompatdata.meaning",
    limitKey: "explain.topics.externalCompatdata.limit",
    glossary: [{ de: "externer Compatdata-Hinweis", en: "external compatdata hint" }],
  },
  "cleanup-blocked": {
    titleKey: "explain.topics.cleanupBlocked.title",
    sourceKey: "explain.topics.cleanupBlocked.source",
    meaningKey: "explain.topics.cleanupBlocked.meaning",
    limitKey: "explain.topics.cleanupBlocked.limit",
    glossary: [
      { de: "Bereinigung blockiert", en: "cleanup blocked" },
      { de: "vorhandener Anzeigestand", en: "existing displayed state" },
    ],
  },
  "steam-owned": {
    titleKey: "explain.topics.steamOwned.title",
    sourceKey: "explain.topics.steamOwned.source",
    meaningKey: "explain.topics.steamOwned.meaning",
    limitKey: "explain.topics.steamOwned.limit",
    glossary: [
      { de: "steam-eigen", en: "steam-owned" },
      { de: "vorhandener Anzeigestand", en: "existing displayed state" },
    ],
  },
  "incomplete-deletion": {
    titleKey: "explain.topics.incompleteDeletion.title",
    sourceKey: "explain.topics.incompleteDeletion.source",
    meaningKey: "explain.topics.incompleteDeletion.meaning",
    limitKey: "explain.topics.incompleteDeletion.limit",
    glossary: [
      { de: "abgebrochene Löschung", en: "incomplete deletion" },
      { de: "vorhandener Anzeigestand", en: "existing displayed state" },
    ],
  },
} as const satisfies Readonly<Record<ExplainTopic, ExplainTopicDefinition>>;
