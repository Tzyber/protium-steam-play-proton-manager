<script setup lang="ts">
import { computed, onMounted } from "vue";
import { parseLogRecord } from "../../core/logline";
import { useLatestLoad } from "../composables/useLatestLoad";
import { dateTimeText, timeText } from "../dateTime";
import { formatBytes } from "../format";
import { formatError } from "../formatError";
import { t } from "../i18n";
import { type ConfigBackupEntry, ports } from "../ports";
import { useUiStore } from "../stores/uiStore";

const {
  data: snapshots,
  loading: snapshotsLoading,
  error: snapshotsError,
  load: loadSnapshots,
} = useLatestLoad<ConfigBackupEntry[]>([], () => ports.system.listConfigBackups());

// nicht `logError`: so heißt die protokollhilfe in diagnostics.ts; hier steht
// der fehlertext des log-panels.
const {
  data: logText,
  loading: logLoading,
  error: logErrorText,
  load: loadLog,
} = useLatestLoad("", () => ports.system.readLogTail());

// als notification: die fehler-refs der listen erscheinen nur bei leerer liste.
async function openFolder(action: () => Promise<void>) {
  try {
    await action();
  } catch (e) {
    useUiStore().showNotification(formatError(e));
  }
}

function openBackups() {
  return openFolder(() => ports.system.openBackupsFolder());
}

function openLogs() {
  return openFolder(() => ports.system.openLogsFolder());
}

/** Eine Zeile je Stand: was, wofür, wann. Der Dateiname ist Technik und bleibt weg. */
function snapshotLabel(entry: ConfigBackupEntry): string {
  return entry.kind === "localconfig"
    ? t("history.snapshotLaunchOptions", { id: entry.targetId })
    : t("history.snapshotCompatTool", { id: entry.targetId });
}

interface LogLine {
  key: string;
  time: string;
  level: string;
  message: string;
}

/** Grammatik kommt aus dem Kern; hier nur noch die Sprachformatierung. */
function toLogLine(line: string, index: number): LogLine {
  const record = parseLogRecord(line);
  return {
    key: `${index}`,
    time: record.seconds === null ? "" : timeText(record.seconds * 1000),
    level: record.level,
    message: record.message,
  };
}

const logLines = computed<LogLine[]>(() =>
  logText.value
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => toLogLine(line, index)),
);

onMounted(() => {
  void loadSnapshots();
  void loadLog();
});
</script>

<template>
  <section class="hv">
    <header class="bar">
      <div class="title">
        <span class="label">{{ t("history.label") }}</span>
        <h1>{{ t("history.title") }}</h1>
      </div>
    </header>

    <div class="hv-body">
      <section class="block snapshots">
        <div class="section-bar">
          <h2>{{ t("history.snapshotsTitle") }}</h2>
        </div>
        <div class="section-row">
          <p class="hint">{{ t("history.snapshotsHint") }}</p>
          <div class="actions">
            <button
              class="action"
              type="button"
              @click="openBackups"
            >
              {{ t("history.openSnapshotsFolder") }}
            </button>
            <button class="action" type="button" :disabled="snapshotsLoading" @click="loadSnapshots">
              {{ t("history.refresh") }}
            </button>
          </div>
        </div>

        <ul v-if="snapshots.length" class="entries">
          <li v-for="entry in snapshots" :key="entry.fileName">
            <span class="entry-main">{{ snapshotLabel(entry) }}</span>
            <span class="entry-sub">{{ dateTimeText(entry.timestampMs) }} · {{ formatBytes(entry.sizeBytes) }}</span>
          </li>
        </ul>
        <p v-else-if="snapshotsError" class="empty" role="status">{{ snapshotsError }}</p>
        <p v-else-if="!snapshotsLoading" class="empty">{{ t("history.snapshotsEmpty") }}</p>
      </section>

      <section class="block log-block">
        <div class="section-bar">
          <h2>{{ t("history.logTitle") }}</h2>
        </div>
        <div class="section-row">
          <p class="hint">{{ t("history.logHint") }}</p>
          <div class="actions">
            <button class="action" type="button" @click="openLogs">
              {{ t("history.openLogsFolder") }}
            </button>
            <button class="action" type="button" :disabled="logLoading" @click="loadLog">
              {{ t("history.refresh") }}
            </button>
          </div>
        </div>

        <p class="hint mono">{{ t("history.rawHint") }}</p>
        <ol v-if="logLines.length" class="log">
          <li v-for="line in logLines" :key="line.key" :class="line.level">
            <span class="log-time">{{ line.time }}</span>
            <span class="log-level">{{ line.level }}</span>
            <span class="log-msg">{{ line.message }}</span>
          </li>
        </ol>
        <p v-else-if="logErrorText" class="empty" role="status">{{ logErrorText }}</p>
        <p v-else-if="!logLoading" class="empty">{{ t("history.logEmpty") }}</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.hv {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  padding: var(--view-pad) 0 0;
}

.bar {
  flex: 0 0 auto;
  padding: 0 var(--view-pad);
}

.hv-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: 0 var(--view-pad) var(--view-pad);
}

.block {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.snapshots {
  flex: 0 0 auto;
}

.log-block {
  flex: 1 1 auto;
  min-height: 0;
}

.section-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.section-bar h2 {
  margin: 0;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--fg-2);
}

.actions {
  display: flex;
  gap: var(--space-2);
}

.action {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--fg-1);
  font-family: var(--font-body);
  font-size: var(--text-xs);
  cursor: pointer;
}

.action:hover:not(:disabled),
.action:focus-visible {
  border-color: var(--signal-dim);
  color: var(--fg-0);
}

.section-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin: var(--space-2) 0 var(--space-3);
}

.hint {
  margin: 0;
  color: var(--fg-2);
  font-size: var(--text-xs);
}

/* Stände: kompakt und selbst scrollbar, damit das Protokoll erreichbar bleibt. */
.entries {
  max-height: 168px;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: var(--space-1);
  list-style: none;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
  background: var(--bg-1);
}

.entries li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-mono);
}

.entries li + li { border-top: 1px solid var(--line-soft); }
.entry-main { color: var(--fg-1); }
.entry-sub { color: var(--fg-2); white-space: nowrap; }
.empty { color: var(--fg-2); font-size: var(--text-xs); margin: 0; }

/* Protokoll: eigene Scrollfläche, Zeilen wie im Logfile. */
.log {
  flex: 1 1 auto;
  min-height: 120px;
  overflow: auto;
  margin: 0;
  padding: var(--space-2) var(--space-1);
  list-style: none;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
  background: var(--bg-0);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-mono);
}

.log li {
  display: grid;
  grid-template-columns: 5.5rem 3.5rem 1fr;
  gap: var(--space-2);
  padding: 0 var(--space-2);
}

.log-time { color: var(--fg-2); }
.log-level { color: var(--fg-2); text-transform: uppercase; }
.log-msg { color: var(--fg-1); white-space: pre-wrap; word-break: break-word; }
.log li.warn .log-level { color: var(--warning-text); }
.log li.error .log-level { color: var(--danger-fg); }
.log li.error .log-msg { color: var(--fg-0); }
</style>
