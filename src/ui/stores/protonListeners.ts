// Listener-Lebenszyklus des proton-Stores (R-02): aus `protonStore.ts`
// herausgelöst. Die WeakMaps bleiben nach der Store-Instanz geschlüsselt,
// deshalb bekommen die Funktionen immer `store` und nie eine Kopie.

import { tauriPorts } from "../../core/adapters/tauri";
import type { GeRelease } from "../../core/geprotonReleases";
import type { DownloadProgressEvent, InstallPhaseEvent } from "../../core/ports";
import { logError } from "../diagnostics";
import { formatError } from "../formatError";
import { t } from "../i18n";
import type { Job } from "./protonStore";
import { useUiStore } from "./uiStore";

/** Gleitender Mittelwert der Download-Rate: der neue Messwert wiegt leichter
 *  als der bisherige, sonst flackert die Anzeige zwischen den ~1-MB-Events. */
const SPEED_SMOOTHING_KEEP = 0.6;
const SPEED_SMOOTHING_NEW = 0.4;

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

/** genau die Store-teile, die der Listener-Lebenszyklus über `store.` nutzt
 *  (kein `ReturnType<typeof useProtonStore>`: das erzeugt einen zirkulären Typ). */
export interface ProtonListenerStore {
  releases: GeRelease[];
  jobs: Record<string, Job>;
  activeTag: string | null;
  listenerReady: boolean;
  $dispose: () => void;
  disposeListeners(): Promise<void>;
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

export function initListeners(store: ProtonListenerStore): Promise<void> {
  const lifecycle =
    listenerLifecycle.get(store) ??
    ({
      initPromise: null,
      generation: 0,
      disposed: false,
      pending: new Map<number, Set<() => void>>(),
    } satisfies ListenerLifecycle);
  listenerLifecycle.set(store, lifecycle);
  if (store.listenerReady) return Promise.resolve();
  if (lifecycle.initPromise) return lifecycle.initPromise;
  if (!disposeHooks.has(store)) {
    const originalDispose = store.$dispose.bind(store);
    store.$dispose = () => {
      void store.disposeListeners();
      originalDispose();
    };
    disposeHooks.add(store);
  }
  lifecycle.disposed = false;
  const generation = lifecycle.generation + 1;
  lifecycle.generation = generation;
  const pending = new Set<() => void>();
  lifecycle.pending.set(generation, pending);
  const token = {};
  const promise = (async () => {
    try {
      const progressUnlisten = await tauriPorts.system.onDownloadProgress(
        (payload: DownloadProgressEvent) => {
          if (listenerOwnership.get(store)?.token !== token) return;
          const activeTag = store.activeTag;
          const job = activeTag !== null ? store.jobs[activeTag] : undefined;
          if (job?.downloadId === payload.id) {
            applyProgress(job, payload, performance.now());
          }
        },
      );
      pending.add(progressUnlisten);
      if (lifecycle.disposed || lifecycle.generation !== generation) {
        progressUnlisten();
        pending.delete(progressUnlisten);
        return;
      }
      const phaseUnlisten = await tauriPorts.system.onInstallPhase((payload: InstallPhaseEvent) => {
        if (listenerOwnership.get(store)?.token !== token) return;
        const activeTag = store.activeTag;
        const job = activeTag !== null ? store.jobs[activeTag] : undefined;
        if (job?.downloadId === payload.id) {
          job.phase = payload.phase;
          if (payload.verified) {
            job.verified = true;
          }
        }
      });
      pending.add(phaseUnlisten);
      if (lifecycle.disposed || lifecycle.generation !== generation) {
        phaseUnlisten();
        pending.delete(phaseUnlisten);
        for (const unlisten of pending) unlisten();
        pending.clear();
        return;
      }
      listenerOwnership.set(store, {
        unlisteners: [...pending],
        token,
      });
      lifecycle.pending.delete(generation);
      store.listenerReady = true;
      if (!store.releases.length) void store.loadReleases();
    } catch (e) {
      listenerOwnership.delete(store);
      for (const unlisten of pending) unlisten();
      pending.clear();
      lifecycle.pending.delete(generation);
      if (!lifecycle.disposed && lifecycle.generation === generation) {
        logError("Proton-Listener fehlgeschlagen", e);
        useUiStore().showNotification(t("proton.listenerUnavailable", { error: formatError(e) }));
        if (!store.releases.length) void store.loadReleases();
      }
    } finally {
      if (lifecycle.generation === generation) lifecycle.initPromise = null;
    }
  })();
  lifecycle.initPromise = promise;
  return promise;
}

export async function disposeListeners(store: ProtonListenerStore): Promise<void> {
  const lifecycle = listenerLifecycle.get(store);
  if (!lifecycle) {
    store.listenerReady = false;
    return;
  }
  lifecycle.disposed = true;
  lifecycle.generation += 1;
  lifecycle.initPromise = null;
  const ownership = listenerOwnership.get(store);
  listenerOwnership.delete(store);
  store.listenerReady = false;
  if (ownership) {
    for (const unlisten of ownership.unlisteners) unlisten();
  }
  for (const pending of lifecycle.pending.values()) {
    for (const unlisten of pending) unlisten();
    pending.clear();
  }
  lifecycle.pending.clear();
}
