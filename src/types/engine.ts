// M1 document -> engine projection (SS3 "the document is projected two ways",
// SS12 scheduling). Small on purpose: M1 has no reconciler yet (that is M2's
// `buildGraph`/`diff`), so this file names only the two seams M1 actually
// needs and leaves the shape open for M2 to grow into.
//
// Implemented by `app-shell-m1` in src/app/ (the wiring package).

import type { ProjectSnapshot } from "./commands";
import type { AuditionSink } from "./editor";
import type { ChannelId } from "./ids";
import type { ParamRegistry } from "./params";
import type { NoteEventSource, Transport } from "./transport";

/**
 * A `NoteEventSource` (SS12) that can be re-pointed at a new document without
 * rebuilding the transport — the transport captures its `events` dependency
 * once, so this delegating source is how an edit becomes audible.
 *
 * `setDocument` rebuilds the underlying clip scan (M0's
 * `createClipEventSource` over the document's clips) and, because the new
 * scan does not continue the old one, MUST behave as a discontinuity: the
 * transport already calls `onDiscontinuity()` on seeks, and an implementation
 * that swaps clips mid-window has to make the same promise about unpaired
 * note-offs (see `NoteEventSource.onDiscontinuity`).
 */
export interface DocumentNoteEventSource extends NoteEventSource {
  setDocument(doc: ProjectSnapshot): void;
}

/**
 * The engine as the app shell holds it in M1: one transport, one param
 * registry, one instrument per track, and a way to hand it a new document.
 *
 * `applyDocument` is deliberately coarse in M1 (mount instruments for tracks
 * that gained one, dispose those that lost one, re-point the event source,
 * `params.load(doc.paramValues)`). M2 replaces its body with the reconciler's
 * `diff(live, desired)` patch without changing this signature.
 */
export interface ProjectEngine {
  readonly transport: Transport;
  readonly params: ParamRegistry;
  applyDocument(doc: ProjectSnapshot): Promise<void>;
  /** Piano-roll preview target for a track's instrument (SS10 audition). */
  auditionFor(trackId: ChannelId): AuditionSink | undefined;
  dispose(): void;
}
