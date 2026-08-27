// SS12 — "The event iterator walks clips in tick order, unrolling clip loops
// ... on the fly."
//
// This is M0's `NoteEventSource`: given a set of `MidiClip`s it yields the
// note-on/note-off stream in absolute song ticks, half-open over the window
// the scheduler asks for. The transport *loop brace* is unrolled one level up
// (src/engine/transport/transport.ts) because `CreateClipEventSource` takes
// only clips — the brace is transport state, and splitting the look-ahead
// window at the brace is the transport's job.
//
// Nothing here allocates per event or per window: the note orderings are
// precomputed once per source, and the iterator, its result object and the
// yielded `NoteEvent` are all preallocated and reused (the allocation
// contract on `NoteEvent` explicitly permits yielding the same object).
//
// Unrolling model for a clip with `loop`:
//
//   clip-relative:  0 ....... loopEnd ....... +loopLen ....... length
//   content:        [0, loopEnd)  [loopStart, loopEnd)  [loopStart, ...)
//
// i.e. the first pass plays everything up to `loop.end` (so material before
// `loop.start` is a one-shot intro, as in Live), then the region
// `[loop.start, loop.end)` repeats until the clip's `length` runs out. With
// `loop.start === 0` this degenerates to plain tiling. Notes are cut at the
// end of the repetition (and at the clip end), never left ringing across a
// boundary.

import type {
  ChannelId,
  CreateClipEventSource,
  MidiClip,
  Note,
  NoteEvent,
  NoteEventSource,
  Ticks,
} from "../../types";

/** Writable view of the yielded event; consumers only ever see `NoteEvent`. */
type MutableNoteEvent = { -readonly [K in keyof NoteEvent]: NoteEvent[K] };

/** One clip, prepared for scanning, plus its (reused) scan cursor. */
interface ClipPlan {
  readonly trackId: ChannelId;
  readonly clipStart: Ticks;
  readonly length: Ticks;
  readonly hasLoop: boolean;
  readonly loopStart: Ticks;
  readonly loopEnd: Ticks;
  readonly loopLen: Ticks;
  readonly notes: readonly Note[];
  /** Note indices ordered by `start`, with the sorted keys alongside. */
  readonly onOrder: readonly number[];
  readonly onKeys: readonly number[];
  /** Note indices ordered by `start + dur`, with the sorted keys alongside. */
  readonly offOrder: readonly number[];
  readonly offKeys: readonly number[];

  // --- mutable scan state (reset at the start of every window) ---
  seg: number;
  segStartRel: Ticks;
  segEndRel: Ticks;
  contentStart: Ticks;
  contentEnd: Ticks;
  onIdx: number;
  offIdx: number;
  windowEndRel: Ticks;
  /** Absolute tick the previous window ended at, so a window that does NOT
   *  continue it (loop brace, seek, `play(fromTick)`) can be recognised. */
  lastToTick: number;
  /** Content position the cursor was seeked to after such a discontinuity:
   *  notes that started before it never had their note-on emitted on this
   *  pass, so their note-off must be suppressed too. `-Infinity` while the
   *  windows are contiguous. */
  orphanCutoff: number;
  /** Absolute tick of this clip's pending event; `Infinity` when finished. */
  nextTick: number;
  nextIsOn: boolean;
  nextNote: number;
}

/** First index `i` with `keys[i] >= value` (`keys.length` if none). */
function lowerBound(keys: readonly number[], value: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function prepare(clip: MidiClip): ClipPlan {
  // Notes that can never sound are dropped once, here, rather than being
  // re-tested on every window.
  const notes = clip.notes.filter(
    (n) => n.muted !== true && n.dur >= 1 && n.start >= 0,
  );

  const onOrder = notes.map((_, i) => i);
  onOrder.sort((a, b) => notes[a]!.start - notes[b]!.start);
  const onKeys = onOrder.map((i) => notes[i]!.start);

  const offOrder = notes.map((_, i) => i);
  offOrder.sort(
    (a, b) =>
      notes[a]!.start + notes[a]!.dur - (notes[b]!.start + notes[b]!.dur),
  );
  const offKeys = offOrder.map((i) => notes[i]!.start + notes[i]!.dur);

  // A degenerate brace (empty or negative) is treated as "no loop".
  const raw = clip.loop;
  const loop =
    raw !== undefined && raw.start >= 0 && raw.end > raw.start ? raw : undefined;
  const hasLoop = loop !== undefined;

  return {
    trackId: clip.trackId,
    clipStart: clip.start,
    length: Math.max(clip.length, 0),
    hasLoop,
    loopStart: loop?.start ?? 0,
    loopEnd: loop?.end ?? 0,
    loopLen: loop === undefined ? 0 : loop.end - loop.start,
    notes,
    onOrder,
    onKeys,
    offOrder,
    offKeys,
    seg: 0,
    segStartRel: 0,
    segEndRel: 0,
    contentStart: 0,
    contentEnd: 0,
    onIdx: 0,
    offIdx: 0,
    windowEndRel: 0,
    lastToTick: -1,
    orphanCutoff: -Infinity,
    nextTick: Infinity,
    nextIsOn: false,
    nextNote: -1,
  };
}

/** Index of the repetition containing clip-relative position `rel`. */
function segmentAt(p: ClipPlan, rel: Ticks): number {
  if (!p.hasLoop || rel < p.loopEnd) return 0;
  return 1 + Math.floor((rel - p.loopEnd) / p.loopLen);
}

/** Points the cursor at repetition `k` and computes its rel/content bounds. */
function enterSegment(p: ClipPlan, k: number): void {
  // Moving to a different repetition retires the orphan cutoff: every note of
  // the new repetition gets its note-on emitted here, so every note-off in it
  // is paired.
  if (k !== p.seg) p.orphanCutoff = -Infinity;
  p.seg = k;
  if (!p.hasLoop) {
    p.segStartRel = 0;
    p.segEndRel = p.length;
    p.contentStart = 0;
    p.contentEnd = p.length;
    return;
  }
  if (k === 0) {
    p.segStartRel = 0;
    p.segEndRel = Math.min(p.loopEnd, p.length);
    p.contentStart = 0;
    p.contentEnd = p.segEndRel;
    return;
  }
  p.segStartRel = p.loopEnd + (k - 1) * p.loopLen;
  p.segEndRel = Math.min(p.segStartRel + p.loopLen, p.length);
  p.contentStart = p.loopStart;
  p.contentEnd = p.loopStart + Math.max(p.segEndRel - p.segStartRel, 0);
}

/** Positions both note indices at clip-relative position `rel` inside the
 *  segment the cursor is currently in. `suppressOrphans` marks the seek as a
 *  jump rather than a continuation: the cutoff it sets then survives the
 *  contiguous windows that follow, for the rest of this repetition (see
 *  `ClipPlan.orphanCutoff`). */
function seekWithinSegment(p: ClipPlan, rel: Ticks, suppressOrphans = false): void {
  const contentPos = p.contentStart + (rel - p.segStartRel);
  if (suppressOrphans) p.orphanCutoff = contentPos;
  p.onIdx = lowerBound(p.onKeys, contentPos);
  // A note-off is clamped to the segment end, and clamping is monotonic, so
  // `clamped >= contentPos` iff `raw >= contentPos` for any `contentPos` at
  // or before the segment end — the same binary search works for both.
  p.offIdx = lowerBound(p.offKeys, contentPos);
}

/**
 * Consumes this clip's next event within the current window into
 * `p.next*`, or sets `p.nextTick = Infinity` when the window is done.
 */
function step(p: ClipPlan): void {
  const count = p.notes.length;
  for (;;) {
    let onRel = Infinity;
    if (p.onIdx < count && p.onKeys[p.onIdx]! < p.contentEnd) {
      onRel = p.segStartRel + (p.onKeys[p.onIdx]! - p.contentStart);
    }

    // Skip note-offs whose note did not *start* where its note-on would have
    // been emitted: outside this repetition, or — after a brace wrap or a
    // seek landing mid-note — before the position this pass started at. A
    // note-off with no matching note-on would otherwise reach the instrument
    // (the `NoteTarget` contract promises pairing, and an instrument that
    // voices overlapping same-pitch notes separately would cut a live voice).
    while (p.offIdx < count) {
      const start = p.notes[p.offOrder[p.offIdx]!]!.start;
      if (start >= p.contentStart && start < p.contentEnd && start >= p.orphanCutoff) break;
      p.offIdx++;
    }
    let offRel = Infinity;
    if (p.offIdx < count) {
      const raw = p.offKeys[p.offIdx]!;
      const clamped = raw < p.contentEnd ? raw : p.contentEnd;
      offRel = p.segStartRel + (clamped - p.contentStart);
    }

    if (onRel === Infinity && offRel === Infinity) {
      const nextStart = p.segEndRel;
      if (nextStart >= p.windowEndRel || nextStart >= p.length) {
        p.nextTick = Infinity;
        return;
      }
      enterSegment(p, p.seg + 1);
      seekWithinSegment(p, nextStart);
      continue;
    }

    // Ties resolve note-off before note-on, so a repeated pitch is released
    // before it is retriggered.
    const offFirst = offRel <= onRel;
    const rel = offFirst ? offRel : onRel;
    if (rel >= p.windowEndRel) {
      p.nextTick = Infinity;
      return;
    }
    if (offFirst) {
      p.nextIsOn = false;
      p.nextNote = p.offOrder[p.offIdx]!;
      p.offIdx++;
    } else {
      p.nextIsOn = true;
      p.nextNote = p.onOrder[p.onIdx]!;
      p.onIdx++;
    }
    p.nextTick = p.clipStart + rel;
    return;
  }
}

/** Resets a clip's cursor for the window `[fromTick, toTick)`. `forced` is
 *  the transport's explicit `onDiscontinuity()` flag. */
function beginWindow(
  p: ClipPlan,
  fromTick: Ticks,
  toTick: Ticks,
  forced: boolean,
): void {
  p.nextTick = Infinity;
  // Contiguous windows continue the previous pass; anything else is a jump
  // (transport loop brace, `seek`, `play(fromTick)`) that must not emit the
  // note-offs of notes whose note-on it skipped over.
  //
  // The tick comparison alone is not enough to recognise one: a `seek` can
  // land exactly on the previous window's `toTick`, and a stall re-anchor
  // keeps the ticks contiguous while cutting every sounding note. Both are
  // announced by `onDiscontinuity()` instead — `forced` is that flag. The
  // comparison stays as the fallback for a caller that never announces.
  const jumped = forced || fromTick !== p.lastToTick;
  p.lastToTick = toTick;
  if (p.notes.length === 0 || p.length <= 0) return;
  // `length + 1`, not `length`: a note cut at the clip end produces a
  // note-off exactly *at* `length`, which is still one of this clip's events.
  const relTo = Math.min(toTick - p.clipStart, p.length + 1);
  const relFrom = Math.max(fromTick - p.clipStart, 0);
  if (relFrom >= relTo) return;
  p.windowEndRel = relTo;

  const prevSeg = p.seg;
  const prevCutoff = p.orphanCutoff;

  const k = segmentAt(p, relFrom);
  enterSegment(p, k);
  if (k > 0 && relFrom === p.segStartRel) {
    // The window opens exactly on a repetition boundary. Start one repetition
    // earlier, parked at its very end, so the note-offs cut at that boundary
    // are emitted before the next repetition's note-ons. (They cannot have
    // been emitted already: the previous window excluded its own end tick.)
    enterSegment(p, k - 1);
  }
  // `enterSegment` retires the orphan cutoff whenever the repetition changes,
  // which is right for a cursor moving FORWARD into fresh material — but the
  // two calls above can also step out of the current repetition and straight
  // back into it (the boundary back-up), and that must not silently discard a
  // suppression this pass still owes. A window that continues the previous one
  // and ends up in the repetition it was already in keeps the cutoff; a jump
  // re-arms it in `seekWithinSegment` below.
  if (!jumped && p.seg === prevSeg) p.orphanCutoff = prevCutoff;
  seekWithinSegment(p, relFrom, jumped);
  step(p);
}

/**
 * M0's clip-backed `NoteEventSource`. The clip list is a snapshot: rebuild
 * the source when the document's clips change (the transport holds the source
 * by reference, so swapping it is the wiring layer's job).
 */
export const createClipEventSource: CreateClipEventSource = (
  clips: readonly MidiClip[],
): NoteEventSource => {
  const plans = clips.map(prepare);

  let endTick = 0;
  for (const p of plans) {
    const end = p.clipStart + p.length;
    if (end > endTick) endTick = end;
  }

  // Preallocated iteration machinery (SS12: zero allocation per tick).
  const event: MutableNoteEvent = {
    type: "noteOn",
    tick: 0,
    trackId: "",
    pitch: 0,
    vel: 0,
  };
  const yieldResult: IteratorYieldResult<NoteEvent> = {
    done: false,
    value: event,
  };
  const doneResult: IteratorReturnResult<undefined> = {
    done: true,
    value: undefined,
  };

  const iterator: Iterator<NoteEvent, undefined> = {
    next(): IteratorResult<NoteEvent, undefined> {
      // k-way merge across clips: pick the earliest pending event. `plans` is
      // small (one entry per clip), so a linear scan beats a heap and keeps
      // the path allocation-free.
      let best: ClipPlan | null = null;
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i]!;
        if (p.nextTick === Infinity) continue;
        if (best === null || p.nextTick < best.nextTick) best = p;
      }
      if (best === null) return doneResult;

      const note = best.notes[best.nextNote]!;
      event.type = best.nextIsOn ? "noteOn" : "noteOff";
      event.tick = best.nextTick;
      event.trackId = best.trackId;
      event.pitch = note.pitch;
      event.vel = best.nextIsOn ? note.vel : 0;
      step(best);
      return yieldResult;
    },
  };

  const iterable: Iterable<NoteEvent> = {
    [Symbol.iterator](): Iterator<NoteEvent, undefined> {
      return iterator;
    },
  };

  // Set by `onDiscontinuity`, consumed by the next window: the transport is
  // telling us that whatever it had scheduled has been released, so notes
  // already under way must not get a note-off from this pass.
  let discontinuous = false;

  return {
    eventsInRange(fromTick: Ticks, toTick: Ticks): Iterable<NoteEvent> {
      const forced = discontinuous;
      discontinuous = false;
      for (let i = 0; i < plans.length; i++) {
        beginWindow(plans[i]!, fromTick, toTick, forced);
      }
      return iterable;
    },
    onDiscontinuity(): void {
      discontinuous = true;
    },
    endTick(): Ticks {
      return endTick;
    },
  };
};
