import { listen } from "@tauri-apps/api/event";
import { defineStore } from "pinia";
import { appCacheDir, tauriPorts } from "../../core/adapters/tauri";
import {
  type FetchSource,
  fetchReleases,
  type GeRelease,
  installRelease,
} from "../../core/geproton";
import type { CompatTool } from "../../core/types";
import { errMsg } from "../format";
import { t } from "../i18n";
import { useScanStore } from "./scanStore";
import { useUiStore } from "./uiStore";

export type Phase = "queued" | "downloading" | "verifying" | "extracting";

interface Job {
  tag: string;
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
    async init() {
      if (this.listenerReady) return;
      try {
        await listen<{ id: string; downloaded: number; total: number | null }>(
          "download-progress",
          (e) => {
            const job = this.jobs[e.payload.id];
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
          },
        );
        this.listenerReady = true;
      } catch (e) {
        // ohne listener fehlt nur die fortschritts-anzeige, die view darf
        // deshalb nicht leer bleiben, und der nächste mount darf es erneut
        // versuchen (flag bleibt false).
        useUiStore().showNotification(t("proton.listenerUnavailable", { error: errMsg(e) }));
      }
      if (!this.releases.length) void this.loadReleases();
    },

    async loadReleases(force = false) {
      this.loading = true;
      this.loadError = null;
      try {
        const result = await fetchReleases(tauriPorts.http, tauriPorts.cache, Date.now, force);
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
      this.jobs[release.tag] = { tag: release.tag, phase: "queued", downloaded: 0, total: null };
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
        // zwei wege, weil sie zwei fenster abdecken:
        // 1. cancelRequested → greift VOR der registrierung im backend
        //    (appCacheDir + hash-asset-abruf); ohne das verpufft der klick still
        //    und der download läuft trotzdem komplett durch.
        // 2. `cancelDownload` bricht den laufenden
        //    download ab und räumt die partielle datei auf.
        // beide wege enden im wurf von installRelease() → pump()-catch entfernt
        // den job.
        const job = this.jobs[tag];
        if (job) job.cancelRequested = true;
        await tauriPorts.system.cancelDownload(tag).catch(() => {});
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
      // warnung erst nach erfolgreichem install publizieren, eine abgebrochene
      // oder fehlgeschlagene installation hat nichts installiert und dürfte
      // sonst „ohne verifikation installiert" neben der fehlermeldung zeigen.
      let warned = false;
      try {
        if (!steamRoot) throw new Error(t("proton.noScanResult"));
        const cacheDir = `${await appCacheDir()}/downloads`;
        await installRelease(tauriPorts, {
          steamRoot,
          cacheDir,
          release,
          downloadId: tag,
          onPhase: (p) => {
            job.phase = p;
            // „entpacke" ohne vorherige warnung und mit hash-asset = geprüft.
            // ohne asset ist der download bewusst unverifiziert (kein flag).
            if (p === "extracting" && release.sha512Url && !warned) job.verified = true;
          },
          onWarning: () => {
            warned = true;
          },
          isCancelled: () => this.jobs[tag]?.cancelRequested === true,
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
      if (!steamRoot || tool.source !== "user") return;
      this.busyRemove = tool.name;
      try {
        // NUR für GE-tools aufrufen (distro-tools gehören dem paketmanager)
        await tauriPorts.system.removeCompatTool(steamRoot, tool.name);
        await scan.runScan();
      } catch (e) {
        this.loadError = t("proton.removeFailed", { msg: errMsg(e) });
      } finally {
        this.busyRemove = null;
      }
    },
  },
});
