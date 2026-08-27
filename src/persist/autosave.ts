// SS13 — "Autosave debounced ~2 s to OPFS."
//
// `createAutosave` wires a `DocumentStore` to a `ProjectStorage` through a
// `ProjectCodec`: it subscribes to `DocumentStore.onChange` and coalesces
// however many commands land inside `AUTOSAVE_DEBOUNCE_MS` into ONE pending
// write, exactly as the `Autosave` contract in ../types/persist.ts requires.
// `flush()` is what `visibilitychange`/`pagehide` and "export" call to make
// sure a pending edit actually lands before the tab (or the write) closes.
//
// Five rules the naive version got wrong, all of them about the document
// moving while a write is in flight or under a document REPLACEMENT:
//
//   1. The storage key follows the DOCUMENT, not the session. `ProjectStorage`
//      is documented as "one slot per project id" (../types/persist.ts), so
//      after New/Import the new project must land in ITS OWN slot instead of
//      overwriting the slot of the project that happened to be open first.
//   2. A replaced document (New/Import) is dirty as far as STORAGE is
//      concerned. The store clears its dirty flag on `replaceDocument` ("a
//      freshly loaded document matches what is on disk"), which is true of the
//      file it came from and false of this app's OPFS slot — so autosave
//      tracks that case itself and writes it.
//   3. `markSaved()` may only be called when the document has not changed
//      since the bytes were encoded. Every change bumps `docSeq`; a write that
//      finishes against a stale sequence leaves the store dirty and schedules
//      another pass, so an edit made during an in-flight write is never lost.
//   5. `flush()` captures its bytes SYNCHRONOUSLY. It is what New/Import call
//      immediately before `replaceDocument`, and a capture deferred behind an
//      await would encode the INCOMING document (under the incoming id),
//      losing everything the user did to the outgoing one inside the debounce
//      window — the whole project, on a first run.
//   4. Writes to the slot are SERIALIZED. `ProjectStorage.write` is a
//      promise; two overlapping writes can settle in either order, and the
//      loser lands LAST — leaving older bytes on disk while the store is
//      marked saved (and `flush()` then has nothing to redo, so a pagehide
//      cannot repair it). Every write chains onto the previous one, the same
//      queue discipline `src/app/engine/projectEngine.ts` uses.

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
  /** An explicit key pins the slot; otherwise the slot is the document's id,
   *  re-read at every write so New/Import re-points it (rule 1 above). */
  const pinnedKey = options?.key;

  let status: AutosaveStatus = IDLE_STATUS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  /** Bumped by every document change (rule 3). */
  let docSeq = 0;
  /** Set when the document was REPLACED under us (rule 2). */
  let replaced = false;
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

  /** Storage is behind the document when the store is dirty OR the document
   *  was swapped for one this autosave has never written. */
  function needsWrite(): boolean {
    return replaced || deps.store.isDirty();
  }

  /** Failed attempts since the last successful write or document change. */
  let errorRetries = 0;
  /** How many times a failing write is retried before autosave gives up. */
  const MAX_ERROR_RETRIES = 3;

  /** Whether a REPLACE (not just an edit) landed after sequence `seq`. */
  let lastReplaceSeq = 0;
  function isReplacedSince(seq: number): boolean {
    return lastReplaceSeq > seq;
  }

  /** Bytes to write plus the document state they were taken from. Captured
   *  SYNCHRONOUSLY (rule 5). */
  interface WriteJob {
    readonly seq: number;
    readonly wasReplaced: boolean;
    readonly key: string;
    readonly text: string;
  }

  /** Encodes the document AS IT IS RIGHT NOW. No await before the read, so a
   *  caller that replaces the document immediately afterwards cannot make
   *  these bytes stale (rule 5). */
  function captureWrite(): WriteJob {
    const project = toProject(deps.store.getState());
    return {
      seq: docSeq,
      wasReplaced: replaced,
      key: pinnedKey ?? project.id,
      text: deps.codec.encode(project, { pretty: false }),
    };
  }

  async function runWrite(job: WriteJob): Promise<void> {
    if (disposed) return;
    const { seq, wasReplaced, key, text } = job;
    setStatus({ state: "saving", lastSavedAt: status.lastSavedAt, error: null });
    try {
      await deps.storage.write(key, text);
      if (seq === docSeq) {
        deps.store.markSaved();
        replaced = false;
        errorRetries = 0;
        setStatus({ state: "saved", lastSavedAt: Date.now(), error: null });
        return;
      }
      // The document moved while these bytes were in flight: they are already
      // stale, so the store stays dirty and another pass is scheduled. Only
      // the replacement flag this write consumed is cleared.
      if (wasReplaced && !isReplacedSince(seq)) replaced = false;
      setStatus({ state: "pending", lastSavedAt: Date.now(), error: null });
      scheduleIfNeeded();
    } catch (err) {
      setStatus({
        state: "error",
        lastSavedAt: status.lastSavedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      // A failed write must not park the document forever: the store is still
      // dirty and nothing else will ever ask again unless the user happens to
      // edit. Retry on a bounded backoff (a transient quota/lock error clears;
      // a permanent one stops complaining after a few tries and leaves the
      // "Save failed" status up).
      scheduleRetry();
    }
  }

  async function performWrite(): Promise<void> {
    if (disposed) return;
    if (!needsWrite()) {
      setStatus({ state: "idle", lastSavedAt: status.lastSavedAt, error: null });
      return;
    }
    await runWrite(captureWrite());
  }

  function writeNow(): Promise<void> {
    // Rule 4: queue behind whatever is already writing, and only THEN read the
    // document — so the last write to start is also the last to land, and it
    // encodes the newest state rather than a snapshot taken before the wait.
    const p: Promise<void> = (inFlight ?? Promise.resolve())
      .then(() => performWrite())
      .finally(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
    return p;
  }

  function scheduleRetry(): void {
    if (disposed || !deps.storage.available) return;
    if (!needsWrite()) return;
    if (timer !== null) return;
    if (errorRetries >= MAX_ERROR_RETRIES) return;
    errorRetries += 1;
    // Backoff, and NO status change: the "error" the user is looking at is
    // still the truth until the retry succeeds.
    timer = setTimeout(
      () => {
        timer = null;
        void writeNow();
      },
      debounceMs * 2 ** errorRetries,
    );
  }

  function scheduleIfNeeded(): void {
    if (disposed || !deps.storage.available) return;
    if (!needsWrite()) return;
    if (timer !== null) return; // already pending
    setStatus({ state: "pending", lastSavedAt: status.lastSavedAt, error: null });
    timer = setTimeout(() => {
      timer = null;
      void writeNow();
    }, debounceMs);
  }

  const unsubscribe: Unsub = deps.store.onChange((change) => {
    docSeq += 1;
    // A fresh edit deserves a fresh retry budget.
    errorRetries = 0;
    if (change.source === "load" || change.source === "replace") {
      replaced = true;
      lastReplaceSeq = docSeq;
    }
    scheduleIfNeeded();
  });

  return {
    get status(): AutosaveStatus {
      return status;
    },
    flush(): Promise<void> {
      if (disposed || !deps.storage.available) return Promise.resolve();
      clearTimer();
      // Rule 5: the payload is captured HERE, synchronously, before any
      // await. New/Import call `flush()` and replace the document in the very
      // next statement (App.tsx) — the outgoing project's edits have to be
      // encoded by then, or the write that eventually runs would encode the
      // INCOMING document under the incoming id and the old project's slot
      // would never be written.
      const job = needsWrite() ? captureWrite() : null;
      const previous = inFlight;
      const drained = (async (): Promise<void> => {
        // Wait for a write that is already running, then write AGAIN if the
        // document moved while it was in flight — flush is the last chance to
        // persist before the tab goes away, so it must not settle on stale
        // bytes just because it arrived mid-write. (`performWrite`, not
        // `writeNow`: this IS the head of the queue, and queueing behind
        // itself would deadlock.)
        if (previous !== null) await previous;
        clearTimer();
        if (job !== null) await runWrite(job);
        if (needsWrite()) await performWrite();
      })();
      const tracked: Promise<void> = drained.finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
      // Later writes queue behind this one (rule 4).
      inFlight = tracked;
      return tracked;
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
