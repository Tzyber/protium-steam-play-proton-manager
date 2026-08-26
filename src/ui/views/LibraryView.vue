<script setup lang="ts">
import { computed, ref } from "vue";
import type { ScanWarning, SkipReason } from "../../core/types";
import FilterBar from "../components/FilterBar.vue";
import GameCard from "../components/GameCard.vue";
import GameDetailDrawer from "../components/GameDetailDrawer.vue";
import { filterAndSortGames } from "../filter";
import { t } from "../i18n";
import { useLibraryStore } from "../stores/libraryStore";
import { useScanStore } from "../stores/scanStore";

const scan = useScanStore();
const lib = useLibraryStore();

const visible = computed(() =>
  filterAndSortGames(scan.games, {
    search: lib.search,
    sortKey: lib.sortKey,
    sortDir: lib.sortDir,
    tiers: lib.tierSet,
    compatTools: lib.compatToolSet,
    libraries: lib.librarySet,
    protonCheckAppIds: lib.protonCheck ? scan.protonCheckAppIds : undefined,
  }),
);

const statusText = computed(() =>
  scan.protonDbRemaining > 0
    ? t("library.protonDbRemaining", { n: scan.protonDbRemaining })
    : scan.statusText,
);

const showWarnings = ref(false);
const coverageDetailsId = "library-coverage-details";
const coverageTitleId = "library-coverage-title";
const coverageState = computed(() => scan.coverage?.state ?? "");
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

const coverageLabel = computed(() => {
  const coverage = scan.coverage;
  if (!coverage) return "";
  if (coverage.state === "complete") {
    return t("library.coverageComplete", {
      libraries: coverage.libraries.total,
      games: scan.games.length,
    });
  }
  return coverage.state === "limited"
    ? t("library.coverageLimited")
    : t("library.coverageIncomplete");
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
  scan.warnings.filter(
    (warning): warning is Extract<ScanWarning, { type: "compat-config" | "launch-config" }> =>
      warning.type === "compat-config" || warning.type === "launch-config",
  ),
);
const manifestWarnings = computed(() =>
  scan.warnings.filter(
    (warning): warning is Extract<ScanWarning, { type: "manifest" }> => warning.type === "manifest",
  ),
);
const toolWarnings = computed(() =>
  scan.warnings.filter(
    (warning): warning is Extract<ScanWarning, { type: "compat-tool" }> =>
      warning.type === "compat-tool",
  ),
);
const libraryWarnings = computed(() =>
  scan.warnings.filter(
    (warning): warning is Extract<ScanWarning, { type: "library" }> => warning.type === "library",
  ),
);

function formatLibraryReason(reason: SkipReason): string {
  switch (reason) {
    case "path-missing":
      return t("library.coverageReasonPathMissing");
    case "scope-failed":
      return t("library.coverageReasonScopeFailed");
    case "read-failed":
      return t("library.coverageReasonReadFailed");
  }
}

function formatConfigStatus(status: "available" | "missing" | "unreadable" | "ambiguous"): string {
  switch (status) {
    case "available":
      return t("library.coverageStatusAvailable");
    case "missing":
      return t("library.coverageStatusMissing");
    case "unreadable":
      return t("library.coverageStatusUnreadable");
    case "ambiguous":
      return t("library.coverageStatusAmbiguous");
  }
}

function formatWarning(warning: ScanWarning): string {
  switch (warning.type) {
    case "library":
      switch (warning.reason) {
        case "path-missing":
          return t("library.coverageWarningLibrary", {
            path: warning.path,
            reason: t("library.coverageReasonPathMissing"),
            detail: warning.detail ?? "",
          });
        case "scope-failed":
          return t("library.coverageWarningLibrary", {
            path: warning.path,
            reason: t("library.coverageReasonScopeFailed"),
            detail: warning.detail ?? "",
          });
        case "read-failed":
          return t("library.coverageWarningLibrary", {
            path: warning.path,
            reason: t("library.coverageReasonReadFailed"),
            detail: warning.detail ?? "",
          });
      }
      break;
    case "compat-config":
      return t("library.coverageWarningConfig", {
        source: t("library.coverageCompatConfig"),
        reason:
          warning.reason === "missing"
            ? t("library.coverageReasonMissing")
            : t("library.coverageReasonUnreadable"),
        detail: warning.detail ?? "",
      });
    case "launch-config": {
      const account = warning.steamUserId
        ? t("library.coverageLaunchAccount", { id: warning.steamUserId })
        : "";
      const detail = [account, warning.detail].filter((part) => part !== "").join(" · ");
      return t("library.coverageWarningConfig", {
        source: t("library.coverageLaunchConfig"),
        reason:
          warning.reason === "missing"
            ? t("library.coverageReasonMissing")
            : warning.reason === "unreadable"
              ? t("library.coverageReasonUnreadable")
              : t("library.coverageReasonSelectionAmbiguous"),
        detail,
      });
    }
    case "manifest":
      switch (warning.reason) {
        case "invalid-filename":
          return t("library.coverageWarningManifest", {
            name: warning.manifestName,
            reason: t("library.coverageReasonInvalidFilename"),
            detail: warning.detail ?? "",
          });
        case "unreadable":
          return t("library.coverageWarningManifest", {
            name: warning.manifestName,
            reason: t("library.coverageReasonUnreadable"),
            detail: warning.detail ?? "",
          });
        case "invalid-content":
          return t("library.coverageWarningManifest", {
            name: warning.manifestName,
            reason: t("library.coverageReasonInvalidContent"),
            detail: warning.detail ?? "",
          });
        case "appid-mismatch":
          return t("library.coverageWarningManifest", {
            name: warning.manifestName,
            reason: t("library.coverageReasonAppIdMismatch"),
            detail: warning.detail ?? "",
          });
        case "duplicate":
          return t("library.coverageWarningManifest", {
            name: warning.manifestName,
            reason: t("library.coverageReasonDuplicate"),
            detail: warning.detail ?? "",
          });
      }
      break;
    case "compat-tool":
      switch (warning.reason) {
        case "path-identity":
          return t("library.coverageWarningTool", {
            name: warning.toolName ?? warning.directory,
            directory: warning.directory,
            reason: t("library.coverageReasonPathIdentity"),
            detail: warning.detail ?? "",
          });
        case "directory-unreadable":
          return t("library.coverageWarningTool", {
            name: warning.toolName ?? warning.directory,
            directory: warning.directory,
            reason: t("library.coverageReasonDirectoryUnreadable"),
            detail: warning.detail ?? "",
          });
        case "symlink":
          return t("library.coverageWarningTool", {
            name: warning.toolName ?? warning.directory,
            directory: warning.directory,
            reason: t("library.coverageReasonSymlink"),
            detail: warning.detail ?? "",
          });
        case "vdf-unreadable":
          return t("library.coverageWarningTool", {
            name: warning.toolName ?? warning.directory,
            directory: warning.directory,
            reason: t("library.coverageReasonVdfUnreadable"),
            detail: warning.detail ?? "",
          });
        case "vdf-invalid":
          return t("library.coverageWarningTool", {
            name: warning.toolName ?? warning.directory,
            directory: warning.directory,
            reason: t("library.coverageReasonVdfInvalid"),
            detail: warning.detail ?? "",
          });
        case "size-unreadable":
          return t("library.coverageWarningTool", {
            name: warning.toolName ?? warning.directory,
            directory: warning.directory,
            reason: t("library.coverageReasonSizeUnreadable"),
            detail: warning.detail ?? "",
          });
      }
      break;
  }
  return t("library.coverageUnknownWarning");
}
</script>

<template>
  <section class="library">
    <header class="bar">
      <div class="title">
        <span class="label">{{ t("library.label") }}</span>
        <h1>
          {{ visible.length }}
          <span class="unit">{{ t("library.gamesCount", { n: scan.games.length }) }}</span>
        </h1>
      </div>

      <div class="right">
        <span class="status" role="status" aria-live="polite" aria-atomic="true">{{ statusText }}</span>
        <button class="rescan" type="button" :disabled="scan.status === 'scanning'" @click="scan.runScan()">
          {{ scan.status === "scanning" ? t("library.scanning") : t("library.rescan") }}
        </button>
      </div>
    </header>

    <section v-if="scan.coverage" class="coverage" :class="`coverage--${coverageState}`">
      <span v-if="coverageNeedsAttention" class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {{ coverageLabel }}. {{ t("library.coverageLocalOnly") }}
      </span>
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

      <transition name="fade">
        <div
          v-show="showWarnings"
          :id="coverageDetailsId"
          class="coverage-details"
          role="region"
          :aria-labelledby="coverageTitleId"
        >
          <section
            class="coverage-group coverage-card"
            :class="libraryNeedsAttention ? 'coverage-card--attention' : 'coverage-card--complete'"
          >
            <h2>{{ t("library.coverageLibraries") }}</h2>
            <p class="coverage-card-summary">
              {{ t("library.coverageLibrariesSummary", {
                read: scan.coverage.libraries.read,
                unavailable: scan.coverage.libraries.unavailable,
              }) }}
            </p>
            <ul>
              <li v-for="library in libraryRows" :key="library.path">
                <span v-if="library.reason">
                  {{ t("library.coverageLibraryUnavailable", { path: library.path }) }}
                </span>
                <span v-else>{{ t("library.coverageLibraryRead", { path: library.path }) }}</span>
                <span v-if="library.reason"> — {{ formatLibraryReason(library.reason) }}</span>
              </li>
              <li v-for="(warning, index) in libraryWarnings" :key="`library-warning-${index}`">
                {{ formatWarning(warning) }}
              </li>
            </ul>
          </section>

          <section
            class="coverage-group coverage-card"
            :class="configNeedsAttention ? 'coverage-card--attention' : 'coverage-card--complete'"
          >
            <h2>{{ t("library.coverageConfiguration") }}</h2>
            <p class="coverage-card-summary">
              {{ t("library.coverageConfigStatus", { source: t("library.coverageCompatConfig"), status: formatConfigStatus(scan.coverage.compatConfig) }) }}
            </p>
            <p>
              {{ t("library.coverageConfigStatus", { source: t("library.coverageLaunchConfig"), status: formatConfigStatus(scan.coverage.launchConfig) }) }}
            </p>
            <ul>
              <li v-for="(warning, index) in configWarnings" :key="`config-warning-${index}`">
                {{ formatWarning(warning) }}
              </li>
            </ul>
          </section>

          <section
            class="coverage-group coverage-card"
            :class="manifestNeedsAttention ? 'coverage-card--attention' : 'coverage-card--complete'"
          >
            <h2>{{ t("library.coverageManifests") }}</h2>
            <p class="coverage-card-summary">
              {{ t("library.coverageCounts", { read: scan.coverage.manifests.read, failed: scan.coverage.manifests.failed }) }}
            </p>
            <ul>
              <li v-for="(warning, index) in manifestWarnings" :key="`manifest-warning-${index}`">
                {{ formatWarning(warning) }}
              </li>
            </ul>
          </section>

          <section
            class="coverage-group coverage-card"
            :class="toolNeedsAttention ? 'coverage-card--attention' : 'coverage-card--complete'"
          >
            <h2>{{ t("library.coverageTools") }}</h2>
            <p class="coverage-card-summary">
              {{ t("library.coverageCounts", { read: scan.coverage.tools.read, failed: scan.coverage.tools.failed }) }}
            </p>
            <ul>
              <li v-for="(warning, index) in toolWarnings" :key="`tool-warning-${index}`">
                {{ formatWarning(warning) }}
              </li>
            </ul>
          </section>
        </div>
      </transition>
    </section>

    <FilterBar v-if="scan.games.length" />

    <div v-if="scan.status === 'not-found'" class="empty">
      {{ t("library.noSteamFound") }}
    </div>
    <div v-else-if="scan.status === 'error'" class="empty err" role="alert">{{ t("library.errorPrefix", { error: scan.error ?? "" }) }}</div>
    <div v-else-if="scan.status === 'scanning' && !scan.games.length" class="empty">{{ t("library.scanningState") }}</div>
    <div v-else-if="!visible.length" class="empty">
      {{ t("library.nothingFound") }}<button class="linklike" type="button" @click="lib.reset()">{{ t("library.resetFilter") }}</button>
    </div>

    <ul v-else class="grid">
      <li v-for="g in visible" :key="g.appId" class="grid-item">
        <GameCard :game="g" />
      </li>
    </ul>

    <GameDetailDrawer />
  </section>
</template>

<style scoped>
.library { padding: 20px 24px; scrollbar-gutter: stable; }

.bar {
  gap: 16px;
}
.title h1 {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 1.625rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.title .unit { color: var(--fg-2); font-size: 0.9375rem; font-weight: 400; }

.right { display: flex; align-items: center; gap: 12px; }
.status { color: var(--fg-2); font-size: 0.875rem; }

.rescan {
  background: var(--signal);
  color: #0a0b11;
  border: none;
  border-radius: var(--r-sm);
  padding: 8px 14px;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 1rem;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
}
.rescan:hover:not(:disabled) { background: var(--signal-bright); box-shadow: 0 0 20px -4px var(--signal-glow); }
.rescan:disabled { opacity: 0.5; cursor: default; }

.coverage {
  margin: 0 0 18px;
  overflow: hidden;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}
.coverage--limited,
.coverage--incomplete {
  border-color: color-mix(in srgb, var(--tier-gold) 40%, var(--line));
}
.coverage-toggle {
  display: flex;
  width: 100%;
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
  background: color-mix(in srgb, var(--tier-gold) 15%, transparent);
  color: var(--tier-gold);
  font-weight: 700;
}
.coverage-summary {
  display: block;
  color: var(--fg-1);
  font-size: 0.875rem;
  font-weight: 600;
}
.coverage-context { display: block; margin-top: 2px; color: var(--fg-2); font-size: 0.75rem; }
.coverage--limited .coverage-summary,
.coverage--incomplete .coverage-summary,
.coverage--limited .coverage-action,
.coverage--incomplete .coverage-action { color: var(--tier-gold); }
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
.coverage-card--attention { border-color: color-mix(in srgb, var(--tier-gold) 35%, var(--line)); }
.coverage-card-summary { color: var(--fg-1); }
.coverage-card--attention .coverage-card-summary { color: var(--tier-gold); }
.coverage-card--complete .coverage-card-summary { color: var(--tier-platinum); }
.coverage-group ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.coverage-group li { padding-top: 6px; border-top: 1px solid var(--line); }

@media (max-width: 760px) {
  .coverage-details { grid-template-columns: 1fr; }
  .coverage-toggle { align-items: flex-start; flex-direction: column; gap: 6px; }
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--gap);
  list-style: none;
  padding: 0;
  margin: 0;
}
.grid-item { display: contents; }

.empty {
  padding: 60px 0;
  text-align: center;
  color: var(--fg-2);
  font-family: var(--font-body);
}
.empty.err { color: var(--tier-borked); }
.linklike { background: none; border: none; color: var(--signal-bright); cursor: pointer; font: inherit; text-decoration: underline; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
