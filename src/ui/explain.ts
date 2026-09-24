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
  | "incomplete-deletion"
  | "explicit-mapping-count"
  | "ge-delete-scope";

interface ExplainTopicDefinition {
  readonly titleKey: Key;
  readonly sourceKey: Key;
  readonly meaningKey: Key;
}

export const EXPLAIN_TOPICS = {
  "explicit-mapping-count": {
    titleKey: "explain.topics.explicitMappingCount.title",
    sourceKey: "explain.topics.explicitMappingCount.source",
    meaningKey: "explain.topics.explicitMappingCount.meaning",
  },
  "ge-delete-scope": {
    titleKey: "explain.topics.geDeleteScope.title",
    sourceKey: "explain.topics.geDeleteScope.source",
    meaningKey: "explain.topics.geDeleteScope.meaning",
  },
  "compat-tool": {
    titleKey: "explain.topics.compatTool.title",
    sourceKey: "explain.topics.compatTool.source",
    meaningKey: "explain.topics.compatTool.meaning",
  },
  "compat-source": {
    titleKey: "explain.topics.compatSource.title",
    sourceKey: "explain.topics.compatSource.source",
    meaningKey: "explain.topics.compatSource.meaning",
  },
  "global-default": {
    titleKey: "explain.topics.globalDefault.title",
    sourceKey: "explain.topics.globalDefault.source",
    meaningKey: "explain.topics.globalDefault.meaning",
  },
  "config-unavailable": {
    titleKey: "explain.topics.configUnavailable.title",
    sourceKey: "explain.topics.configUnavailable.source",
    meaningKey: "explain.topics.configUnavailable.meaning",
  },
  protondb: {
    titleKey: "explain.topics.protondb.title",
    sourceKey: "explain.topics.protondb.source",
    meaningKey: "explain.topics.protondb.meaning",
  },
  "scan-coverage": {
    titleKey: "explain.topics.scanCoverage.title",
    sourceKey: "explain.topics.scanCoverage.source",
    meaningKey: "explain.topics.scanCoverage.meaning",
  },
  "tool-unrecognized": {
    titleKey: "explain.topics.toolUnrecognized.title",
    sourceKey: "explain.topics.toolUnrecognized.source",
    meaningKey: "explain.topics.toolUnrecognized.meaning",
  },
  footprint: {
    titleKey: "explain.topics.footprint.title",
    sourceKey: "explain.topics.footprint.source",
    meaningKey: "explain.topics.footprint.meaning",
  },
  "external-compatdata": {
    titleKey: "explain.topics.externalCompatdata.title",
    sourceKey: "explain.topics.externalCompatdata.source",
    meaningKey: "explain.topics.externalCompatdata.meaning",
  },
  "cleanup-blocked": {
    titleKey: "explain.topics.cleanupBlocked.title",
    sourceKey: "explain.topics.cleanupBlocked.source",
    meaningKey: "explain.topics.cleanupBlocked.meaning",
  },
  "steam-owned": {
    titleKey: "explain.topics.steamOwned.title",
    sourceKey: "explain.topics.steamOwned.source",
    meaningKey: "explain.topics.steamOwned.meaning",
  },
  "incomplete-deletion": {
    titleKey: "explain.topics.incompleteDeletion.title",
    sourceKey: "explain.topics.incompleteDeletion.source",
    meaningKey: "explain.topics.incompleteDeletion.meaning",
  },
} as const satisfies Readonly<Record<ExplainTopic, ExplainTopicDefinition>>;
