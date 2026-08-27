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
//
// That suppression is also why the swap is REPORTED. A note sounding when
// the swap happens had its note-on emitted by the old scan; the new scan will
// not emit its note-off, so unless the transport re-anchors (releasing what
// is sounding and pending), the note hangs until playback stops. The return
// value is what lets the caller tell a note edit — which must re-anchor —
// from a param edit, which must not: both arrive here as an ordinary
// document change, and param edits are by far the more common of the two.

import { createClipEventSource } from "../../engine/transport";
import { clipsForEngine } from "../../state";
import type { DocumentNoteEventSource, NoteEvent, ProjectSnapshot, Ticks } from "../../types";

/** Which tracks are muted, as one comparable string. Muting a track removes
 *  its clips from the engine's view (`clipsForEngine`), so it changes the
 *  note stream exactly as an edit does. */
function muteSignature(doc: ProjectSnapshot): string {
  let out = "";
  for (const id of doc.channelOrder) {
    if (doc.channels[id]?.mute === true) out += `${id},`;
  }
  return out;
}

/** Wraps M0's clip-backed source so the app shell can re-point the transport
 *  at an edited document without tearing it down (SS3/SS12). */
export function createDocumentNoteEventSource(
  initialDoc: ProjectSnapshot,
): DocumentNoteEventSource {
  let inner = createClipEventSource(clipsForEngine(initialDoc));
  // The document's `clips` record is structurally shared (immer), so its
  // IDENTITY is an exact "did any clip change" test — and a cheap one, run on
  // every dispatch. `clipsForEngine` copies each clip, so comparing its
  // output instead would always report a change.
  let lastClips: ProjectSnapshot["clips"] = initialDoc.clips;
  let lastMutes = muteSignature(initialDoc);

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
    setDocument(doc: ProjectSnapshot): boolean {
      const mutes = muteSignature(doc);
      if (doc.clips === lastClips && mutes === lastMutes) return false;
      lastClips = doc.clips;
      lastMutes = mutes;
      inner = createClipEventSource(clipsForEngine(doc));
      return true;
    },
  };
}
