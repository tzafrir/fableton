// SS12/SS3 — the document -> transport seam (types/engine.ts
// `DocumentNoteEventSource`): "the transport captures its `events` dependency
// once ... so this delegating source is how an edit becomes audible without
// rebuilding the transport."
//
// `setDocument` swaps in a brand-new `createClipEventSource` scan built from
// the edited document's clips. A fresh scan starts with no memory of a
// previous window (`ClipPlan.lastToTick` resets to `-1` inside
// `createClipEventSource`), so the very next `eventsInRange` call after a
// swap is unconditionally treated as a discontinuity by the clip scanner
// itself — the orphan-note-off suppression `NoteEventSource.onDiscontinuity`
// asks for falls out of that for free; nothing here has to re-implement it.

import { createClipEventSource } from "../../engine/transport";
import { clipsForEngine } from "../../state";
import type { DocumentNoteEventSource, NoteEvent, ProjectSnapshot, Ticks } from "../../types";

/** Wraps M0's clip-backed source so the app shell can re-point the transport
 *  at an edited document without tearing it down (SS3/SS12). */
export function createDocumentNoteEventSource(
  initialDoc: ProjectSnapshot,
): DocumentNoteEventSource {
  let inner = createClipEventSource(clipsForEngine(initialDoc));

  return {
    eventsInRange(fromTick: Ticks, toTick: Ticks): Iterable<NoteEvent> {
      return inner.eventsInRange(fromTick, toTick);
    },
    onDiscontinuity(): void {
      inner.onDiscontinuity?.();
    },
    endTick(): Ticks {
      return inner.endTick();
    },
    setDocument(doc: ProjectSnapshot): void {
      inner = createClipEventSource(clipsForEngine(doc));
    },
  };
}
