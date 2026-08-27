// SS13 — "Autosave debounced ~2 s to OPFS."
//
// `createAutosave` wires a `DocumentStore` to a `ProjectStorage` through a
// `ProjectCodec`: it subscribes to `DocumentStore.onChange` and coalesces
// however many commands land inside `AUTOSAVE_DEBOUNCE_MS` into ONE pending
// write, exactly as the `Autosave` contract in ../types/persist.ts requires.
// `flush()` is what `visibilitychange`/`pagehide` and "export" call to make
// sure a pending edit actually lands before the tab (or the write) closes.

import type {
  Autosave,
  AutosaveOptions,
  AutosaveStatus,
  DocumentStore,
  Project,
  ProjectCodec,
  ProjectSnapshot,
  ProjectStorage,
  Unsub,
} from "../types";
import { AUTOSAVE_DEBOUNCE_MS } from "../types";

/**
 * `DocumentStore.getState()` hands back a deep-readonly `ProjectSnapshot`
 * (structurally identical to `Project`, just frozen). Encoding never
 * mutates, so the cast is safe — the same shape of cast the interface
 * author calls out for `createClipEventSource` in ../types/commands.ts.
 */
export function toProject(snapshot: ProjectSnapshot): Project {
  return snapshot as unknown as Project;
}

export interface AutosaveDeps {
  readonly store: DocumentStore;
  readonly storage: ProjectStorage;
  readonly codec: ProjectCodec;
}

const IDLE_STATUS: AutosaveStatus = { state: "idle", lastSavedAt: null, error: null };

export function createAutosave(deps: AutosaveDeps, options?: AutosaveOptions): Autosave {
  const debounceMs = options?.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const key = options?.key ?? deps.store.getState().id;

  let status: AutosaveStatus = IDLE_STATUS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  const listeners = new Set<(status: AutosaveStatus) => void>();

  function setStatus(next: AutosaveStatus): void {
    status = next;
    for (const cb of listeners) cb(status);
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function performWrite(): Promise<void> {
    if (disposed) return;
    if (!deps.store.isDirty()) {
      setStatus({ state: "idle", lastSavedAt: status.lastSavedAt, error: null });
      return;
    }
    setStatus({ state: "saving", lastSavedAt: status.lastSavedAt, error: null });
    try {
      const text = deps.codec.encode(toProject(deps.store.getState()), { pretty: false });
      await deps.storage.write(key, text);
      deps.store.markSaved();
      setStatus({ state: "saved", lastSavedAt: Date.now(), error: null });
    } catch (err) {
      setStatus({
        state: "error",
        lastSavedAt: status.lastSavedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function runWrite(): void {
    const p = performWrite().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
  }

  function scheduleIfNeeded(): void {
    if (disposed || !deps.storage.available) return;
    if (!deps.store.isDirty()) return;
    if (timer !== null) return; // already pending
    setStatus({ state: "pending", lastSavedAt: status.lastSavedAt, error: null });
    timer = setTimeout(() => {
      timer = null;
      runWrite();
    }, debounceMs);
  }

  const unsubscribe: Unsub = deps.store.onChange(() => scheduleIfNeeded());

  return {
    get status(): AutosaveStatus {
      return status;
    },
    async flush(): Promise<void> {
      if (disposed || !deps.storage.available) return;
      clearTimer();
      if (inFlight) {
        await inFlight;
        return;
      }
      await performWrite();
    },
    onStatusChange(cb: (status: AutosaveStatus) => void): Unsub {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose(): void {
      disposed = true;
      clearTimer();
      unsubscribe();
      listeners.clear();
    },
  };
}
