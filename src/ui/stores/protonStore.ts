import { listen } from "@tauri-apps/api/event";
import { defineStore } from "pinia";
import { tauriPorts } from "../../core/adapters/tauri";
import {
  type FetchSource,
  fetchReleases,
  type GeRelease,
  installRelease,
  isManagedGeName,
} from "../../core/geproton";
import { joinPath, paths } from "../../core/paths";
import type { CompatTool } from "../../core/types";
import { errMsg } from "../format";
import { t } from "../i18n";
import { useConfirmStore } from "./confirmStore";
import { useScanStore } from "./scanStore";
import { useUiStore } from "./uiStore";

export type Phase = "queued" | "downloading" | "verifying" | "extracting";

interface Job {
  tag: string;
  downloadId: string;
  phase: Phase;
  downloaded: number;
  total: number | null;
  /** gleitende durchschnitts-rate (bytes/s) aus den progress-events, nur anzeige. */
  speed?: number;
  speedLastTs?: number;
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

interface ListenerOwnership {
  unlisteners: Array<() => void>;
  token: object;
}

interface ListenerLifecycle {
  initPromise: Promise<void> | null;
  generation: number;
  disposed: boolean;
  pending: Map<number, Set<() => void>>;
}

const listenerLifecycle = new WeakMap<object, ListenerLifecycle>();
const listenerOwnership = new WeakMap<object, ListenerOwnership>();
const disposeHooks = new WeakSet<object>();

interface State {
  releases: GeRelease[];
  loading: boolean;
  loadError: string | null;
  lastFetchedAt: number | null; // letzter echter github-kontakt
  lastSource: FetchSource | null;
  jobs: Record<string, Job>; // key = release.tag
  queue: string[]; // wartende tags (max 1 aktiv)
  activeTag: string | null;
  busyRemove: string | null;
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
    lastFetchedAt: null,
    lastSource: null,
    jobs: {},
    queue: [],
    activeTag: null,
    busyRemove: null,
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
      const lifecycle =
        listenerLifecycle.get(this) ??
        ({
          initPromise: null,
          generation: 0,
          disposed: false,
          pending: new Map<number, Set<() => void>>(),
        } satisfies ListenerLifecycle);
      listenerLifecycle.set(this, lifecycle);
      if (this.listenerReady) return Promise.resolve();
      if (lifecycle.initPromise) return lifecycle.initPromise;
      if (!disposeHooks.has(this)) {
        const originalDispose = this.$dispose.bind(this);
        this.$dispose = () => {
          void this.disposeListeners();
          originalDispose();
        };
        disposeHooks.add(this);
      }
      lifecycle.disposed = false;
      const generation = lifecycle.generation + 1;
      lifecycle.generation = generation;
      const pending = new Set<() => void>();
      lifecycle.pending.set(generation, pending);
      const token = {};
      const promise = (async () => {
        try {
          const progressUnlisten = await listen<{
            id: string;
            downloaded: number;
            total: number | null;
          }>("download-progress", (e) => {
            if (listenerOwnership.get(this)?.token !== token) return;
            const job = Object.values(this.jobs).find(
              (candidate) =>
                candidate.downloadId === e.payload.id && this.activeTag === candidate.tag,
            );
            if (job) {
              const now = Date.now();
              if (job.speedLastTs) {
                // instantan-rate aus dem event-abstand, weich geglättet
                // events sind ~1-MB-throttled, rohwerte würden flackern
                const inst =
                  ((e.payload.downloaded - job.downloaded) * 1000) / (now - job.speedLastTs);
                job.speed = job.speed ? 0.6 * job.speed + 0.4 * inst : inst;
              }
              job.speedLastTs = now;
              job.downloaded = e.payload.downloaded;
              job.total = e.payload.total;
            }
          });
          pending.add(progressUnlisten);
          if (lifecycle.disposed || lifecycle.generation !== generation) {
            progressUnlisten();
            pending.delete(progressUnlisten);
            return;
          }
          const phaseUnlisten = await listen<{ id: string; phase: Phase; verified: boolean }>(
            "install-phase",
            (e) => {
              if (listenerOwnership.get(this)?.token !== token) return;
              const job = Object.values(this.jobs).find(
                (candidate) =>
                  candidate.downloadId === e.payload.id && this.activeTag === candidate.tag,
              );
              if (job) {
                job.phase = e.payload.phase;
                if (e.payload.verified) {
                  job.verified = true;
                }
              }
            },
          );
          pending.add(phaseUnlisten);
          if (lifecycle.disposed || lifecycle.generation !== generation) {
            phaseUnlisten();
            pending.delete(phaseUnlisten);
            for (const unlisten of pending) unlisten();
            pending.clear();
            return;
          }
          listenerOwnership.set(this, {
            unlisteners: [...pending],
            token,
          });
          lifecycle.pending.delete(generation);
          this.listenerReady = true;
          if (!this.releases.length) void this.loadReleases();
        } catch (e) {
          listenerOwnership.delete(this);
          for (const unlisten of pending) unlisten();
          pending.clear();
          lifecycle.pending.delete(generation);
          if (!lifecycle.disposed && lifecycle.generation === generation) {
            useUiStore().showNotification(t("proton.listenerUnavailable", { error: errMsg(e) }));
            if (!this.releases.length) void this.loadReleases();
          }
        } finally {
          if (lifecycle.generation === generation) lifecycle.initPromise = null;
        }
      })();
      lifecycle.initPromise = promise;
      return promise;
    },

    async disposeListeners() {
      const lifecycle = listenerLifecycle.get(this);
      if (!lifecycle) {
        this.listenerReady = false;
        return;
      }
      lifecycle.disposed = true;
      lifecycle.generation += 1;
      lifecycle.initPromise = null;
      const ownership = listenerOwnership.get(this);
      listenerOwnership.delete(this);
      this.listenerReady = false;
      if (ownership) {
        for (const unlisten of ownership.unlisteners) unlisten();
      }
      for (const pending of lifecycle.pending.values()) {
        for (const unlisten of pending) unlisten();
        pending.clear();
      }
      lifecycle.pending.clear();
    },

    async loadReleases(force = false) {
      this.loading = true;
      this.loadError = null;
      try {
        const targetArch = await tauriPorts.system.geTargetArch();
        const result = await fetchReleases(
          tauriPorts.http,
          tauriPorts.cache,
          targetArch,
          Date.now,
          force,
        );
        this.releases = result.releases;
        this.lastFetchedAt = result.fetchedAt;
        this.lastSource = result.source;
        if (!this.releases.length && result.source === "offline") {
          this.loadError = t("proton.noReleases");
        }
      } catch (e) {
        this.loadError = errMsg(e);
      } finally {
        this.loading = false;
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
        if (job) job.cancelRequested = true;
        if (job) await tauriPorts.system.cancelDownload(job.downloadId).catch(() => {});
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
        if (!steamRoot) throw new Error(t("proton.noScanResult"));
        await installRelease(tauriPorts, {
          steamRoot,
          release,
          downloadId,
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
        if (warned) {
          this.warning = { tag, msg: t("proton.checksumUnavailable", { tag }) };
        } else if (this.warning?.tag === tag) {
          this.warning = null; // verifizierter reinstall desselben tags räumt die alte warnung
        }
        delete this.jobs[tag];
      } catch (e) {
        const msg = errMsg(e);
        if (!/cancel/i.test(msg)) this.loadError = t("proton.installFailed", { tag, msg });
        delete this.jobs[tag];
      } finally {
        this.activeTag = null;
        void this.pump(); // nächster in der queue
      }
    },

    async remove(tool: CompatTool) {
      const scan = useScanStore();
      const steamRoot = scan.result?.steamRoot;
      if (!steamRoot || tool.source !== "user" || !isManagedGeName(tool.name)) return;
      this.busyRemove = tool.name;
      try {
        // NUR für GE-tools aufrufen (distro-tools gehören dem paketmanager)
        const toolDir = joinPath(paths.compatToolsDir(steamRoot), tool.name);
        const pending = await tauriPorts.system.prepareDelete({
          targetType: "compatTool",
          path: toolDir,
          steamRoot,
        });
        // bestätigungsdialog im hauptfenster; erst der klick führt das
        // löschen aus (v0.3.1-look: "{name} löschen?").
        const confirm = useConfirmStore();
        confirm.ask(
          {
            title: t("proton.removeConfirmTitle", { name: tool.name }),
            message: pending.consequences.map((c) => c.description).join("\n"),
          },
          {
            onSuccess: async () => {
              try {
                const res = await tauriPorts.system.executeDelete(pending.token);
                if (res.success) {
                  await scan.runScan();
                }
              } finally {
                this.busyRemove = null;
              }
            },
            onCancel: () => {
              this.busyRemove = null;
            },
          },
        );
      } catch (e) {
        this.loadError = t("proton.removeFailed", { msg: errMsg(e) });
        this.busyRemove = null;
      }
    },
  },
});
