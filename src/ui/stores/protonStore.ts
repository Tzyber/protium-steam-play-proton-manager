import { defineStore } from "pinia";
import { EXTRACT_TEMP_PREFIX } from "../../core/compat";
import { ProtiumError } from "../../core/errors";
import { errText, parseError } from "../../core/errtext";
import { type FetchSource, fetchReleases, installRelease } from "../../core/geproton";
import { isManagedGeName } from "../../core/geprotonNames";
import type { GeRelease } from "../../core/geprotonReleases";
import { paths } from "../../core/paths";
import type { PendingDeleteInfo, InstallPhase as Phase } from "../../core/ports";
import type { CompatTool } from "../../core/types";
import { localizeConsequences } from "../consequences";
import { logError, logEvent } from "../diagnostics";
import { formatError } from "../formatError";
import { getLocale, t } from "../i18n";
import { type LatestGuard, latest } from "../latest";
import { ports } from "../ports";
import { runDeleteFlow } from "./deleteFlow";
import { initListeners } from "./protonListeners";
import { useScanStore } from "./scanStore";

export type { Phase };

export interface Job {
  tag: string;
  downloadId: string;
  phase: Phase;
  downloaded: number;
  total: number | null;
  /** gleitende durchschnitts-rate (bytes/s) aus den progress-events, nur anzeige. */
  speed?: number;
  speedBase?: { ts: number; bytes: number };
  /** sha512-vergleich bestanden (nur gesetzt, wenn es ein hash-asset gab). */
  verified?: boolean;
  /** vom nutzer angefordert, solange der job noch existiert. lebt bewusst hier
   *  und nicht in der rust-registry: der store kennt den job-lebenszyklus, das
   *  backend nur laufende downloads. eine vorgemerkte id im backend würde als
   *  leiche liegenbleiben und den nächsten versuch derselben version killen. */
  cancelRequested?: boolean;
}

let downloadSequence = 0;

function createDownloadId(): string {
  downloadSequence += 1;
  return `proton-${Date.now().toString(36)}-${downloadSequence.toString(36)}`;
}

/** Auftrags-Token je Store für `loadReleases`: `init()` und der Refresh-Knopf
 *  können parallel laden, und eine langsame ältere Antwort darf weder die
 *  frischeren Releases überschreiben noch den Ladezustand des jüngeren
 *  Auftrags beenden (U-05). */
const releasesGuard = new WeakMap<object, LatestGuard>();

function getReleasesGuard(store: object): LatestGuard {
  let guard = releasesGuard.get(store);
  if (!guard) {
    guard = latest();
    releasesGuard.set(store, guard);
  }
  return guard;
}

/** backend-ablehnungen beim löschen lokalisieren; das write-gate (steam läuft)
 *  bekommt einen eigenen text statt des rohen backend-strings. */
function removeErrorText(e: unknown): string {
  return parseError(e).code === "steam-running"
    ? t("proton.removeSteamRunning")
    : t("proton.removeFailed", { msg: formatError(e) });
}

function isValidExtractLeftoverName(name: string): boolean {
  if (!name.startsWith(EXTRACT_TEMP_PREFIX)) return false;
  return /^[1-9][0-9]*-[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(
    name.slice(EXTRACT_TEMP_PREFIX.length),
  );
}

function parseExtractLeftovers(e: unknown): string[] {
  const parsed = parseError(e);
  const prefix = "incomplete extraction leftovers found: ";
  if (parsed.code !== "incomplete" || !parsed.detail?.startsWith(prefix)) return [];
  const listPart = parsed.detail.slice(prefix.length).split(";")[0] ?? "";
  return listPart
    .split(",")
    .map((entry) => entry.trim())
    .filter(isValidExtractLeftoverName);
}

interface State {
  releases: GeRelease[];
  loading: boolean;
  loadError: string | null;
  /** fehler beim entfernen eines installierten tools. bewusst ein eigenes feld:
   *  er gehört in den installiert-abschnitt (die ansicht rendert `loadError`
   *  unter der release-überschrift) und darf nicht von jedem release-refresh
   *  oder einer erfolgreichen installation gelöscht werden (A-05). */
  removeError: string | null;
  lastFetchedAt: number | null; // letzter echter github-kontakt
  lastSource: FetchSource | null;
  jobs: Record<string, Job>; // key = release.tag
  queue: string[]; // wartende tags (max 1 aktiv)
  activeTag: string | null;
  busyRemove: string | null;
  extractLeftovers: string[];
  listenerReady: boolean;
  /** warnung an den installierten release gebunden, nicht an den job, der job
   *  wird nach erfolgreichem install gelöscht. überschreiben statt reset. */
  warning: { tag: string; msg: string } | null;
}

export const useProtonStore = defineStore("proton", {
  state: (): State => ({
    releases: [],
    loading: false,
    loadError: null,
    removeError: null,
    lastFetchedAt: null,
    lastSource: null,
    jobs: {},
    queue: [],
    activeTag: null,
    busyRemove: null,
    extractLeftovers: [],
    listenerReady: false,
    warning: null,
  }),
  getters: {
    installedTools(): CompatTool[] {
      return useScanStore().compatTools;
    },
  },
  actions: {
    init() {
      return initListeners(this);
    },

    async loadReleases(force = false) {
      // nur der jüngste Auftrag schreibt Ergebnis, Fehler und Ladezustand;
      // ältere Antworten verpuffen.
      const isCurrent = getReleasesGuard(this).begin();
      this.loading = true;
      this.loadError = null;
      try {
        const targetArch = await ports.system.geTargetArch();
        const result = await fetchReleases(ports.http, ports.cache, targetArch, Date.now, force);
        if (!isCurrent()) return;
        this.releases = result.releases;
        this.lastFetchedAt = result.fetchedAt;
        this.lastSource = result.source;
        if (!this.releases.length && result.source === "offline") {
          this.loadError = t("proton.noReleases");
        }
      } catch (e) {
        logError("GE-Releases laden fehlgeschlagen", e);
        if (!isCurrent()) return;
        this.loadError = formatError(e);
      } finally {
        // der Ladezustand endet erst mit dem aktuellen Auftrag; sonst gäbe ein
        // überholter Lauf den Refresh-Knopf frei, während der neue noch lädt.
        if (isCurrent()) this.loading = false;
      }
    },

    clearWarning() {
      this.warning = null;
    },

    queueInstall(release: GeRelease) {
      if (this.jobs[release.tag]) return; // schon in arbeit / queued
      this.jobs[release.tag] = {
        tag: release.tag,
        downloadId: createDownloadId(),
        phase: "queued",
        downloaded: 0,
        total: null,
      };
      this.queue.push(release.tag);
      void this.pump();
    },

    /** bricht einen download ab, queued: sofort raus; aktiv: rust-abbruch + cleanup. */
    async cancel(tag: string) {
      const queuedIdx = this.queue.indexOf(tag);
      if (queuedIdx >= 0) {
        this.queue.splice(queuedIdx, 1); // noch nicht gestartet → einfach entfernen
        delete this.jobs[tag];
        return;
      }
      if (this.activeTag === tag) {
        // zwei wege decken die grenze vor und während der backend-registrierung
        // ab. `cancelRequested` wird am start von installRelease geprüft;
        // `cancelDownload` weckt danach den laufenden Rust-Download oder
        // SHA-Abruf und löst Temp-/Registry-Cleanup aus.
        // beide wege enden im wurf von installRelease() → pump()-catch entfernt
        // den job.
        const job = this.jobs[tag];
        if (job) {
          job.cancelRequested = true;
          await ports.system.cancelDownload(job.downloadId).catch((e: unknown) => {
            // der abbruch ist bereits vorgemerkt; ein fehlgeschlagener
            // backend-weckruf darf nicht still verschwinden (P6).
            logEvent("warn", `Download-Abbruch fehlgeschlagen (${tag}): ${errText(e)}`);
          });
        }
      }
    },

    async pump() {
      if (this.activeTag || !this.queue.length) return;
      const tag = this.queue.shift();
      if (!tag) return;
      const release = this.releases.find((r) => r.tag === tag);
      const job = this.jobs[tag];
      if (!release || !job) {
        // release nach einem refresh nicht mehr in der github-liste: der job
        // würde ewig mit cancel-button herumliegen und die queue stünde still.
        delete this.jobs[tag];
        void this.pump();
        return;
      }

      this.activeTag = tag;
      const scan = useScanStore();
      const steamRoot = scan.result?.steamRoot;
      const downloadId = job.downloadId;
      // warnung erst nach erfolgreichem install publizieren, eine abgebrochene
      // oder fehlgeschlagene installation hat nichts installiert und dürfte
      // sonst „ohne verifikation installiert" neben der fehlermeldung zeigen.
      let warned = false;
      try {
        // Absichtsfehler als code-tragender Fehler (B1/N-3): der install-fehler
        // zeigt über formatError den gepflegten text statt "unbekannt".
        if (!steamRoot) {
          throw new ProtiumError("not-found", "no-scan-result", t("proton.noScanResult"));
        }
        await installRelease(ports, {
          steamRoot,
          release,
          downloadId,
          locale: getLocale(),
          onPhase: (p) => {
            if (this.jobs[tag] === job && job.downloadId === downloadId) job.phase = p;
          },
          onWarning: () => {
            warned = true;
          },
          isCancelled: () =>
            this.jobs[tag]?.downloadId === downloadId && this.jobs[tag]?.cancelRequested === true,
        });
        await scan.runScan(); // frische compatToolsInstalled + usedBy
        this.loadError = null; // stale fehlermeldung eines früheren fehlschlags
        this.extractLeftovers = [];
        if (warned) {
          logEvent("warn", `GE-Pruefsumme nicht verfuegbar (${tag})`);
          this.warning = { tag, msg: t("proton.checksumUnavailable", { tag }) };
        } else if (this.warning?.tag === tag) {
          this.warning = null; // verifizierter reinstall desselben tags räumt die alte warnung
        }
        delete this.jobs[tag];
      } catch (e) {
        const parsed = parseError(e);
        if (parsed.code !== "cancelled") {
          logError(`GE-Installation fehlgeschlagen (${tag})`, e);
          this.loadError =
            parsed.code === "tool-already-exists"
              ? t("proton.installExists", { tag })
              : t("proton.installFailed", { tag, msg: formatError(e) });
          this.extractLeftovers = parsed.code === "incomplete" ? parseExtractLeftovers(e) : [];
        }
        delete this.jobs[tag];
      } finally {
        this.activeTag = null;
        void this.pump(); // nächster in der queue
      }
    },

    async confirmCompatDirDelete(options: {
      steamRoot: string;
      targetType: "compatTool" | "extractLeftover";
      name: string;
      title: string;
      message: (pending: PendingDeleteInfo) => string;
      afterExecute: () => Promise<void>;
    }) {
      await runDeleteFlow({
        items: [options.name],
        onReserve: () => {
          // ein neuer versuch ersetzt die meldung des vorigen; sie bleibt sonst
          // stehen, bis der nutzer erneut löscht (A-05).
          this.removeError = null;
          this.busyRemove = options.name;
        },
        prepareItem: async (name) => {
          const targetDir = paths.compatToolDir(options.steamRoot, name);
          const pending = await ports.system.prepareDelete({
            targetType: options.targetType,
            path: targetDir,
            steamRoot: options.steamRoot,
          });
          return { token: pending.token, pending };
        },
        onPrepareError: (_name, e) => {
          this.removeError = removeErrorText(e);
        },
        buildDialog: ([prepared]) => ({
          title: options.title,
          message: prepared ? options.message(prepared.pending) : "",
        }),
        afterExecute: options.afterExecute,
        onUnexpectedError: (e) => {
          this.removeError = removeErrorText(e);
        },
        onCleanup: () => {
          this.busyRemove = null;
        },
      });
    },

    async remove(tool: CompatTool) {
      const scan = useScanStore();
      const steamRoot = scan.result?.steamRoot;
      if (!steamRoot || tool.source !== "user" || !isManagedGeName(tool.name)) return;
      await this.confirmCompatDirDelete({
        steamRoot,
        // NUR für GE-tools aufrufen (distro-tools gehören dem paketmanager)
        targetType: "compatTool",
        name: tool.name,
        // bestätigungsdialog im hauptfenster; erst der klick führt das
        // löschen aus (v0.3.1-look: "{name} löschen?").
        title: t("proton.removeConfirmTitle", { name: tool.name }),
        message: (pending) =>
          [...localizeConsequences(pending), t("proton.removeKeepsPrefixes")].join("\n"),
        afterExecute: async () => {
          await scan.runScan();
        },
      });
    },

    async removeLeftover(leftoverName: string) {
      const scan = useScanStore();
      const steamRoot = scan.result?.steamRoot;
      if (!steamRoot || !isValidExtractLeftoverName(leftoverName)) return;
      await this.confirmCompatDirDelete({
        steamRoot,
        targetType: "extractLeftover",
        name: leftoverName,
        title: t("proton.removeLeftoverConfirmTitle", { name: leftoverName }),
        message: (pending) => localizeConsequences(pending).join("\n"),
        afterExecute: async () => {
          this.extractLeftovers = this.extractLeftovers.filter((item) => item !== leftoverName);
          if (this.extractLeftovers.length === 0) {
            this.loadError = null;
          }
        },
      });
    },
  },
});
