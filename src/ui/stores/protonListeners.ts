// Listener-Lebenszyklus des proton-Stores (R-02): aus `protonStore.ts`
// herausgelöst. `inflightInit` bleibt nach der Store-Instanz geschlüsselt,
// damit parallele `init()`-Aufrufe pro Instanz eine Registrierung teilen.

import type { GeRelease } from "../../core/geprotonReleases";
import type { DownloadProgressEvent, InstallPhaseEvent } from "../../core/ports";
import { logError } from "../diagnostics";
import { formatError } from "../formatError";
import { t } from "../i18n";
import { ports } from "../ports";
import type { Job } from "./protonStore";
import { useUiStore } from "./uiStore";

/** Gleitender Mittelwert der Download-Rate: der neue Messwert wiegt leichter
 *  als der bisherige, sonst flackert die Anzeige zwischen den ~1-MB-Events. */
const SPEED_SMOOTHING_KEEP = 0.6;
const SPEED_SMOOTHING_NEW = 0.4;

const inflightInit = new WeakMap<object, Promise<void>>();

/** genau die Store-teile, die der Listener-Lebenszyklus über `store.` nutzt
 *  (kein `ReturnType<typeof useProtonStore>`: das erzeugt einen zirkulären Typ). */
interface ProtonListenerStore {
  releases: GeRelease[];
  jobs: Record<string, Job>;
  activeTag: string | null;
  listenerReady: boolean;
  loadReleases(): Promise<void>;
}

/** Die Speed-Glättung als reine Funktion: liest nur job und payload, kein
 *  weiterer Store-Zustand. */
function applyProgress(job: Job, payload: DownloadProgressEvent, now: number): void {
  const base = job.speedBase;
  // ohne zeitfortschritt bleibt die messbasis stehen: inst liefe auf
  // Infinity, und weitergeschoben fehlten die bytes dieser probe in
  // der nächsten rate.
  if (!base || now > base.ts) {
    if (base) {
      const inst = ((payload.downloaded - base.bytes) * 1000) / (now - base.ts);
      if (Number.isFinite(inst)) {
        job.speed = job.speed
          ? SPEED_SMOOTHING_KEEP * job.speed + SPEED_SMOOTHING_NEW * inst
          : inst;
      }
    }
    job.speedBase = { ts: now, bytes: payload.downloaded };
  }
  job.downloaded = payload.downloaded;
  job.total = payload.total;
}

function activeJob(store: ProtonListenerStore, downloadId: string): Job | undefined {
  const activeTag = store.activeTag;
  const job = activeTag !== null ? store.jobs[activeTag] : undefined;
  return job?.downloadId === downloadId ? job : undefined;
}

export function initListeners(store: ProtonListenerStore): Promise<void> {
  if (store.listenerReady) return Promise.resolve();
  const active = inflightInit.get(store);
  if (active) return active;

  const promise = (async () => {
    try {
      const progressUnlisten = await ports.system.onDownloadProgress(
        (payload: DownloadProgressEvent) => {
          const job = activeJob(store, payload.id);
          if (job) applyProgress(job, payload, performance.now());
        },
      );
      try {
        await ports.system.onInstallPhase((payload: InstallPhaseEvent) => {
          const job = activeJob(store, payload.id);
          if (!job) return;
          job.phase = payload.phase;
          if (payload.verified) job.verified = true;
        });
      } catch (e) {
        progressUnlisten();
        throw e;
      }
      store.listenerReady = true;
    } catch (e) {
      logError("Proton-Listener fehlgeschlagen", e);
      useUiStore().showNotification(t("proton.listenerUnavailable", { error: formatError(e) }));
    } finally {
      if (!store.releases.length) void store.loadReleases();
      inflightInit.delete(store);
    }
  })();
  inflightInit.set(store, promise);
  return promise;
}
