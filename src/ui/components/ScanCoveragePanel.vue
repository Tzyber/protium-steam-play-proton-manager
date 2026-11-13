<script setup lang="ts">
import { computed, ref } from "vue";
import { effectiveScanCoverage } from "../../core/scan/coverage";
import type { ScanWarning, SkipReason } from "../../core/types";
import { filterWarningsByType } from "../coverageFilter";
import { formatConfigStatus, formatLibraryReason, formatWarning } from "../coverageText";
import type { Key } from "../i18n";
import { t } from "../i18n";
import { useCleanupStore } from "../stores/cleanupStore";
import { useScanStore } from "../stores/scanStore";
import ExplainInfo from "./ExplainInfo.vue";

const scan = useScanStore();
const cleanup = useCleanupStore();

const showWarnings = ref(false);
const coverageDetailsId = "library-coverage-details";
const coverageTitleId = "library-coverage-title";
/** Ein vollständiger Scan belegt nur die Bestandsaufnahme, nicht die
 *  Löschvorschau: die gemeinsame Regel liegt in `effectiveScanCoverage`, damit
 *  Panel und Support-Bericht sich nicht widersprechen (INV-2). */
const coverageState = computed(() =>
  scan.coverage ? effectiveScanCoverage(scan.coverage, cleanup.coverageBlocked) : "",
);
const coverageNeedsAttention = computed(
  () => coverageState.value === "limited" || coverageState.value === "incomplete",
);
const libraryNeedsAttention = computed(
  () => (scan.coverage?.libraries.unavailable ?? 0) > 0 || libraryWarnings.value.length > 0,
);
const configNeedsAttention = computed(
  () =>
    scan.coverage?.compatConfig !== "available" ||
    scan.coverage?.launchConfig !== "available" ||
    configWarnings.value.some(
      (warning) => warning.reason === "missing" || warning.reason === "unreadable",
    ),
);
const manifestNeedsAttention = computed(
  () => (scan.coverage?.manifests.failed ?? 0) > 0 || manifestWarnings.value.length > 0,
);
const toolNeedsAttention = computed(
  () => (scan.coverage?.tools.failed ?? 0) > 0 || toolWarnings.value.length > 0,
);

const attentionGroups = computed(() => {
  const groups: readonly [boolean, Key][] = [
    [libraryNeedsAttention.value, "library.coverageLibraries"],
    [configNeedsAttention.value, "library.coverageConfiguration"],
    [manifestNeedsAttention.value, "library.coverageManifests"],
    [toolNeedsAttention.value, "library.coverageTools"],
    [cleanup.coverageBlocked, "library.coverageCleanup"],
  ];
  return groups
    .filter(([on]) => on)
    .map(([, key]) => t(key))
    .join(", ");
});

const coverageLabel = computed(() => {
  const coverage = scan.coverage;
  if (!coverage) return "";
  if (coverageState.value === "complete") {
    return t("library.coverageComplete", {
      libraries: coverage.libraries.total,
      games: scan.games.length,
    });
  }
  return coverageState.value === "limited"
    ? t("library.coverageLimited", { groups: attentionGroups.value })
    : t("library.coverageIncomplete", { groups: attentionGroups.value });
});

const libraryRows = computed(() => {
  const result = scan.result;
  if (!result) return [];
  const skipReasons = new Map<string, SkipReason>();
  for (const skipped of result.skippedLibraries) {
    if (!skipReasons.has(skipped.path)) skipReasons.set(skipped.path, skipped.reason);
  }
  const paths = new Set([...result.libraries, ...skipReasons.keys()]);
  return [...paths].map((path) => ({ path, reason: skipReasons.get(path) }));
});

const configWarnings = computed(() =>
  filterWarningsByType(scan.warnings, ["compat-config", "launch-config"]),
);
const manifestWarnings = computed(() => filterWarningsByType(scan.warnings, "manifest"));
const toolWarnings = computed(() => filterWarningsByType(scan.warnings, "compat-tool"));
const libraryWarnings = computed(() => filterWarningsByType(scan.warnings, "library"));

/** Eine Karte der Detailfläche. Reihenfolge und Texte sind fest; die
 *  Aufmerksamkeits-Markierung kommt je Gruppe aus dem Scan. */
type CoverageCard = {
  key: "libraries" | "configuration" | "manifests" | "tools";
  attention: boolean;
  title: Key;
  summary: string;
  /** zusätzliche zeilen ohne summary-auszeichnung (launch-config-status). */
  lines: string[];
  rows: { path: string; reason?: SkipReason }[];
  warnings: { key: string; text: string }[];
};

function warningItems(prefix: string, warnings: ScanWarning[]): { key: string; text: string }[] {
  return warnings.map((warning, index) => ({
    key: `${prefix}-warning-${index}`,
    text: formatWarning(warning),
  }));
}

const coverageCards = computed<CoverageCard[]>(() => {
  const coverage = scan.coverage;
  if (!coverage) return [];
  return [
    {
      key: "libraries",
      attention: libraryNeedsAttention.value,
      title: "library.coverageLibraries",
      summary: t("library.coverageLibrariesSummary", {
        read: coverage.libraries.read,
        unavailable: coverage.libraries.unavailable,
      }),
      lines: [],
      rows: libraryRows.value,
      warnings: warningItems("library", libraryWarnings.value),
    },
    {
      key: "configuration",
      attention: configNeedsAttention.value,
      title: "library.coverageConfiguration",
      summary: t("library.coverageConfigStatus", {
        source: t("library.coverageCompatConfig"),
        status: formatConfigStatus(coverage.compatConfig),
      }),
      lines: [
        t("library.coverageConfigStatus", {
          source: t("library.coverageLaunchConfig"),
          status: formatConfigStatus(coverage.launchConfig),
        }),
      ],
      rows: [],
      warnings: warningItems("config", configWarnings.value),
    },
    {
      key: "manifests",
      attention: manifestNeedsAttention.value,
      title: "library.coverageManifests",
      summary: t("library.coverageCounts", {
        read: coverage.manifests.read,
        failed: coverage.manifests.failed,
      }),
      lines: [],
      rows: [],
      warnings: warningItems("manifest", manifestWarnings.value),
    },
    {
      key: "tools",
      attention: toolNeedsAttention.value,
      title: "library.coverageTools",
      summary: t("library.coverageCounts", {
        read: coverage.tools.read,
        failed: coverage.tools.failed,
      }),
      lines: [],
      rows: [],
      warnings: warningItems("tool", toolWarnings.value),
    },
  ];
});
</script>

<template>
  <section v-if="scan.coverage" class="coverage" :class="`coverage--${coverageState}`">
      <span v-if="coverageNeedsAttention" class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {{ coverageLabel }}. {{ t("library.coverageLocalOnly") }}
      </span>
      <div class="coverage-head">
        <button
          class="coverage-toggle"
          type="button"
          :aria-expanded="showWarnings"
          :aria-controls="coverageDetailsId"
          @click="showWarnings = !showWarnings"
        >
          <span class="coverage-heading">
            <span v-if="coverageNeedsAttention" class="coverage-alert" aria-hidden="true">!</span>
            <span>
              <span :id="coverageTitleId" class="coverage-summary">{{ coverageLabel }}</span>
              <span v-if="coverageNeedsAttention" class="coverage-context">{{ t("library.coverageLocalOnly") }}</span>
            </span>
          </span>
          <span class="coverage-action">
            {{ showWarnings ? t("library.coverageDetailsClose") : t("library.coverageDetailsOpen") }}
            <span class="coverage-chevron" aria-hidden="true">{{ showWarnings ? "⌃" : "⌄" }}</span>
          </span>
        </button>
        <ExplainInfo
          class="coverage-explain"
          :label="t('explain.topics.scanCoverage.title')"
          :topics="['scan-coverage']"
        />
      </div>

      <transition name="fade">
        <div
          v-show="showWarnings"
          :id="coverageDetailsId"
          class="coverage-details"
          role="region"
          :aria-labelledby="coverageTitleId"
        >
          <section
            v-for="card in coverageCards"
            :key="card.key"
            class="coverage-group coverage-card"
            :class="card.attention ? 'coverage-card--attention' : 'coverage-card--complete'"
          >
            <h2>{{ t(card.title) }}</h2>
            <p class="coverage-card-summary">{{ card.summary }}</p>
            <p v-for="(line, index) in card.lines" :key="`line-${index}`">{{ line }}</p>
            <ul>
              <li v-for="row in card.rows" :key="row.path">
                <span v-if="row.reason">
                  {{ t("library.coverageLibraryUnavailable", { path: row.path }) }}
                </span>
                <span v-else>{{ t("library.coverageLibraryRead", { path: row.path }) }}</span>
                <span v-if="row.reason"> · {{ formatLibraryReason(row.reason) }}</span>
              </li>
              <li v-for="warning in card.warnings" :key="warning.key">{{ warning.text }}</li>
            </ul>
          </section>
        </div>
      </transition>
    </section>
</template>

<style scoped>
.coverage {
  position: relative;
  margin: 0 0 18px;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}
.coverage--limited,
.coverage--incomplete {
  border-color: var(--warning-border);
}
.coverage-head {
  display: flex;
  align-items: center;
}
.coverage-explain {
  flex: 0 0 auto;
  margin: 0 14px 0 10px;
}
.coverage-toggle {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  background: transparent;
  border: none;
  color: var(--fg-0);
  font-family: var(--font-body);
  cursor: pointer;
  text-align: left;
}
.coverage-toggle:hover { background: var(--bg-2); }
.coverage-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
.coverage-alert {
  display: grid;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 50%;
  background: var(--warning-surface);
  color: var(--warning-text);
  font-weight: 700;
}
.coverage-summary {
  display: block;
  color: var(--fg-1);
  font-size: 0.875rem;
  font-weight: 600;
}
.coverage-context { display: block; margin-top: 2px; color: var(--fg-2); font-size: 0.75rem; }
.coverage--limited .coverage-action,
.coverage--incomplete .coverage-action { color: var(--warning-text); }
.coverage--limited .coverage-summary,
.coverage--incomplete .coverage-summary { color: var(--fg-0); }
.coverage-action {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  color: var(--fg-2);
  font-size: 0.8125rem;
  font-weight: 600;
}
.coverage-chevron { font-size: 1rem; line-height: 1; }

.coverage-details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 24px;
  padding: 14px;
  border-top: 1px solid var(--line);
  background: var(--bg-1);
  font-family: var(--font-body);
  font-size: 0.8125rem;
  color: var(--fg-1);
}
.coverage-group h2 {
  margin: 0 0 8px;
  color: var(--fg-2);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.coverage-group p { margin: 0 0 6px; }
.coverage-card {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-0);
}
.coverage-card--attention { border-color: var(--warning-border); }
.coverage-card-summary { color: var(--fg-1); }
.coverage-card--attention .coverage-card-summary { color: var(--warning-text); }
.coverage-card--complete .coverage-card-summary { color: var(--success-text); }
.coverage-group ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.coverage-group li { padding-top: 6px; border-top: 1px solid var(--line); }

@media (max-width: 760px) {
  .coverage-details { grid-template-columns: 1fr; }
  .coverage-toggle { align-items: flex-start; flex-direction: column; gap: 6px; }
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
