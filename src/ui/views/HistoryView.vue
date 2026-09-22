<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  type ConfigBackupEntry,
  listConfigBackups,
  openBackupsFolder,
  openLogsFolder,
  readLogTail,
} from "../../core/adapters/tauri";
import { formatBytes } from "../format";
import { formatError } from "../formatError";
import { getLocale, t } from "../i18n";

const snapshots = ref<ConfigBackupEntry[]>([]);
const snapshotsLoading = ref(false);
const snapshotsError = ref<string | null>(null);
const logText = ref("");
const logLoading = ref(false);
const logError = ref<string | null>(null);

async function loadSnapshots() {
  snapshotsLoading.value = true;
  snapshotsError.value = null;
  try {
    snapshots.value = await listConfigBackups();
  } catch (e) {
    snapshots.value = [];
    snapshotsError.value = formatError(e);
  } finally {
    snapshotsLoading.value = false;
  }
}

async function loadLog() {
  logLoading.value = true;
  logError.value = null;
  try {
    logText.value = await readLogTail();
  } catch (e) {
    logText.value = "";
    logError.value = formatError(e);
  } finally {
    logLoading.value = false;
  }
}

async function openFolder(action: () => Promise<void>, target: "snapshots" | "logs") {
  try {
    await action();
  } catch (e) {
    if (target === "snapshots") snapshotsError.value = formatError(e);
    else logError.value = formatError(e);
  }
}

/** Eine Zeile je Stand: was, wofür, wann. Der Dateiname ist Technik und bleibt weg. */
function snapshotLabel(entry: ConfigBackupEntry): string {
  return entry.kind === "localconfig"
    ? t("history.snapshotLaunchOptions", { id: entry.targetId })
    : t("history.snapshotCompatTool", { id: entry.targetId });
}

function snapshotTime(entry: ConfigBackupEntry): string {
  return new Date(entry.timestampMs).toLocaleString(getLocale());
}

interface LogLine {
  key: string;
  time: string;
  level: string;
  message: string;
}

/** Logzeilen der Form "[<sekunden>] [LEVEL] text" fuer die Anzeige zerlegen. */
function parseLogLine(line: string, index: number): LogLine {
  const match = /^\[(\d+)\] \[(\w+)\] ?([\s\S]*)$/.exec(line);
  if (match === null) return { key: `${index}`, time: "", level: "", message: line };
  const seconds = Number.parseInt(match[1] ?? "", 10);
  return {
    key: `${index}`,
    time: Number.isFinite(seconds) ? new Date(seconds * 1000).toLocaleTimeString(getLocale()) : "",
    level: (match[2] ?? "").toLowerCase(),
    message: match[3] ?? "",
  };
}

const logLines = computed<LogLine[]>(() =>
  logText.value
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => parseLogLine(line, index)),
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

    <div class="content">
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
              @click="openFolder(openBackupsFolder, 'snapshots')"
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
            <span class="entry-sub">{{ snapshotTime(entry) }} · {{ formatBytes(entry.sizeBytes) }}</span>
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
            <button class="action" type="button" @click="openFolder(openLogsFolder, 'logs')">
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
        <p v-else-if="logError" class="empty" role="status">{{ logError }}</p>
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
  padding: 20px 24px 0;
  min-width: 0;
  overflow-x: hidden;
}

.content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 16px;
}

.block {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.snapshots {
  flex: 0 0 auto;
}

.log-block {
  flex: 1 1 auto;
}

.section-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-bar h2 {
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-2);
}

.actions {
  display: flex;
  gap: 8px;
}

.action {
  padding: 4px 9px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--fg-1);
  font: 0.75rem var(--font-body);
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
  gap: 12px;
  margin: 6px 0 10px;
}

.hint {
  margin: 0;
  color: var(--fg-2);
  font-size: 0.75rem;
}

/* Stände: kompakt und selbst scrollbar, damit das Protokoll erreichbar bleibt. */
.entries {
  max-height: 168px;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: 2px;
  list-style: none;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
  background: var(--bg-1);
}

.entries li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 8px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  line-height: 1.6;
}

.entries li + li { border-top: 1px solid var(--line-soft); }
.entry-main { color: var(--fg-1); }
.entry-sub { color: var(--fg-2); white-space: nowrap; }
.empty { color: var(--fg-2); font-size: 0.78rem; margin: 0; }

/* Protokoll: eigene Scrollfläche, Zeilen wie im Logfile. */
.log {
  flex: 1;
  min-height: 120px;
  overflow: auto;
  margin: 0;
  padding: 6px 4px;
  list-style: none;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
  background: var(--bg-0);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  line-height: 1.65;
}

.log li {
  display: grid;
  grid-template-columns: 5.5rem 3.5rem 1fr;
  gap: 8px;
  padding: 0 6px;
}

.log-time { color: var(--fg-2); }
.log-level { color: var(--fg-2); text-transform: uppercase; }
.log-msg { color: var(--fg-1); white-space: pre-wrap; word-break: break-word; }
.log li.warn .log-level { color: var(--tier-gold); }
.log li.error .log-level { color: var(--tier-borked); }
.log li.error .log-msg { color: var(--fg-0); }
</style>
