// The arrangement's read model: the document, indexed the way the layers and
// the hit-testers need it.
//
// Two SS-mandated properties drive the whole file:
//
//   SS9  "Content culls to the viewport ... the visible window is found by
//         binary search — O(visible) per frame". Each lane owns a `TickIndex`
//         over its clips, so a frame touches only what is on screen.
//   SS13 "The reconciler and editors subscribe to patch streams, so reacting
//         to 'effect moved from chain[2] to chain[0]' is a targeted update,
//         not a full re-scan". `update()` reads the patch paths and re-indexes
//         only the lanes whose clips actually changed.

import type { Channel } from "../../types/document";
import type { Immutable, Patch, ProjectSnapshot } from "../../types/commands";
import type { ChannelId, ClipId } from "../../types/ids";
import type { TickIndex } from "../../types/render";
import type { Ticks } from "../../types/time";
import { createTickIndex } from "../kit";
import type { ClipView } from "./geometry";
import { spansOverlap } from "./geometry";

export interface ArrangementRow {
  readonly channelId: ChannelId;
  /** Index in `channelOrder` — the frozen row convention. */
  readonly row: number;
  readonly channel: Immutable<Channel>;
  /** Clips only live on `'track'` channels (groups/returns/master have none). */
  readonly isTrack: boolean;
  /** This lane's clips, sorted by start. */
  readonly clips: readonly ClipView[];
}

/** What `update()` found in the patch stream, so callers can invalidate the
 *  smallest set of layers (SS9's per-layer redraw triggers). */
export interface SceneChange {
  /** Lane set or order changed: grid + content + headers + row limits. */
  readonly structure: boolean;
  /** Clip data changed: content layer. */
  readonly clips: boolean;
  /** Tempo / time signature / song loop changed: grid layer + ruler. */
  readonly song: boolean;
}

export const NO_CHANGE: SceneChange = { structure: false, clips: false, song: false };

/** Every clip of either kind, in no particular order (each lane sorts its
 *  own). Allocates one array per re-index, which happens on a document
 *  change, never per frame. */
function allClips(doc: ProjectSnapshot): ClipView[] {
  const out: ClipView[] = Object.values(doc.clips);
  for (const clip of Object.values(doc.audioClips)) out.push(clip);
  return out;
}

interface MutableRow {
  channelId: ChannelId;
  row: number;
  channel: Immutable<Channel>;
  isTrack: boolean;
  clips: ClipView[];
  index: TickIndex<ClipView>;
}

export interface ArrangementScene {
  readonly doc: ProjectSnapshot;
  readonly rows: readonly ArrangementRow[];
  rowCount(): number;
  rowOfChannel(channelId: ChannelId): number;
  rowOfClip(clipId: ClipId): number;
  clip(clipId: ClipId): ClipView | undefined;
  channelAt(row: number): Immutable<Channel> | undefined;
  isTrackRow(row: number): boolean;
  /** Clips of one lane overlapping `[from, to)`; appends into `out`. */
  clipsInRange(row: number, from: Ticks, to: Ticks, out?: ClipView[]): readonly ClipView[];
  /** The clip covering `tick` on a lane; the LAST one when clips overlap, so
   *  hit-testing agrees with the paint order (later clips draw on top). */
  clipAtTick(row: number, tick: Ticks): ClipView | undefined;
  /** Every clip intersecting a rectangle in (row, tick) space — the marquee.
   *  Both tick bounds are INCLUSIVE, so a marquee with no horizontal travel
   *  (dragged straight down across lanes) still catches what it covers. */
  clipsIntersecting(rowFrom: number, rowTo: number, from: Ticks, to: Ticks): ClipView[];
  /** Last tick any clip reaches; the viewport's scroll extent follows it. */
  contentEndTick(): Ticks;
  update(doc: ProjectSnapshot, patches?: readonly Patch[] | undefined): SceneChange;
}

const spanOfClip = (clip: ClipView): { start: Ticks; end: Ticks } => ({
  start: clip.start,
  end: clip.start + clip.length,
});

function byStart(a: ClipView, b: ClipView): number {
  return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function createArrangementScene(initial: ProjectSnapshot): ArrangementScene {
  let doc = initial;
  let rows: MutableRow[] = [];
  const rowOfChannelId = new Map<ChannelId, number>();
  const clipRow = new Map<ClipId, number>();
  const clipById = new Map<ClipId, ClipView>();

  const makeRow = (channelId: ChannelId, row: number, channel: Immutable<Channel>): MutableRow => ({
    channelId,
    row,
    channel,
    isTrack: channel.role === "track",
    clips: [],
    index: createTickIndex<ClipView>(spanOfClip),
  });

  /** Re-collects the clips of `targets` (all rows when `null`) in one pass. */
  const fillRows = (targets: ReadonlySet<number> | null): void => {
    for (const row of rows) {
      if (targets === null || targets.has(row.row)) row.clips = [];
    }
    // BOTH maps: the arrangement is the one place that holds MIDI and audio
    // clips together (see `AudioClip`), and to a lane they are the same
    // thing — a rectangle with a start and a length.
    for (const clip of allClips(doc)) {
      const row = rowOfChannelId.get(clip.trackId);
      clipById.set(clip.id, clip);
      if (row === undefined) {
        clipRow.delete(clip.id);
        continue;
      }
      clipRow.set(clip.id, row);
      if (targets !== null && !targets.has(row)) continue;
      rows[row]?.clips.push(clip);
    }
    for (const row of rows) {
      if (targets !== null && !targets.has(row.row)) continue;
      row.clips.sort(byStart);
      row.index.rebuild(row.clips);
    }
  };

  const rebuildStructure = (): void => {
    rows = [];
    rowOfChannelId.clear();
    for (const channelId of doc.channelOrder) {
      const channel = doc.channels[channelId];
      if (channel === undefined) continue;
      rowOfChannelId.set(channelId, rows.length);
      rows.push(makeRow(channelId, rows.length, channel));
    }
    clipRow.clear();
    clipById.clear();
    fillRows(null);
  };

  rebuildStructure();

  /** Classifies the patch stream. `null` paths (a whole-document replace) and
   *  anything unrecognised fall back to a full rebuild. */
  const classify = (patches: readonly Patch[] | undefined): {
    change: SceneChange;
    full: boolean;
    clipIds: Set<ClipId> | null;
  } => {
    if (patches === undefined || patches.length === 0) {
      return { change: { structure: true, clips: true, song: true }, full: true, clipIds: null };
    }
    let structure = false;
    let clips = false;
    let song = false;
    let full = false;
    const clipIds = new Set<ClipId>();
    for (const patch of patches) {
      const head = patch.path[0];
      if (head === "channelOrder" || head === "channels") {
        structure = true;
        // A channel rename/colour edit is structural for the headers too; the
        // cost of re-indexing is paid only when a lane actually changed.
        continue;
      }
      if (head === "clips" || head === "audioClips") {
        clips = true;
        const id = patch.path[1];
        if (typeof id === "string") clipIds.add(id);
        else full = true;
        continue;
      }
      if (head === "tempo" || head === "timeSignature" || head === "loop") {
        song = true;
        continue;
      }
      // An asset's peaks are what an audio clip's waveform is drawn from, so
      // a sample arriving (or leaving) repaints the content layer.
      if (head === "assets") {
        clips = true;
        full = true;
        continue;
      }
      if (head === undefined) full = true;
    }
    return { change: { structure, clips, song }, full, clipIds: full ? null : clipIds };
  };

  const scene: ArrangementScene = {
    get doc() {
      return doc;
    },
    get rows() {
      return rows;
    },
    rowCount(): number {
      return rows.length;
    },
    rowOfChannel(channelId: ChannelId): number {
      return rowOfChannelId.get(channelId) ?? -1;
    },
    rowOfClip(clipId: ClipId): number {
      return clipRow.get(clipId) ?? -1;
    },
    clip(clipId: ClipId): ClipView | undefined {
      return clipById.get(clipId);
    },
    channelAt(row: number): Immutable<Channel> | undefined {
      return rows[row]?.channel;
    },
    isTrackRow(row: number): boolean {
      return rows[row]?.isTrack ?? false;
    },
    clipsInRange(row: number, from: Ticks, to: Ticks, out?: ClipView[]): readonly ClipView[] {
      const lane = rows[row];
      if (lane === undefined) return out ?? [];
      return lane.index.inRange(from, to, out);
    },
    clipAtTick(row: number, tick: Ticks): ClipView | undefined {
      const lane = rows[row];
      if (lane === undefined) return undefined;
      let found: ClipView | undefined;
      for (const clip of lane.index.inRange(tick, tick + 1)) {
        if (tick >= clip.start && tick < clip.start + clip.length) found = clip;
      }
      return found;
    },
    clipsIntersecting(rowFrom: number, rowTo: number, from: Ticks, to: Ticks): ClipView[] {
      const out: ClipView[] = [];
      const lo = Math.max(0, Math.min(rowFrom, rowTo));
      const hi = Math.min(rows.length - 1, Math.max(rowFrom, rowTo));
      const tickLo = Math.min(from, to);
      const tickHi = Math.max(from, to);
      for (let row = lo; row <= hi; row += 1) {
        const lane = rows[row];
        if (lane === undefined) continue;
        for (const clip of lane.index.inRange(tickLo, tickHi + 1)) {
          if (spansOverlap(clip.start, clip.start + clip.length, tickLo, tickHi + 1)) out.push(clip);
        }
      }
      return out;
    },
    contentEndTick(): Ticks {
      let end = 0;
      for (const clip of clipById.values()) {
        const clipEnd = clip.start + clip.length;
        if (clipEnd > end) end = clipEnd;
      }
      return end;
    },
    update(next: ProjectSnapshot, patches?: readonly Patch[] | undefined): SceneChange {
      if (next === doc) return NO_CHANGE;
      const { change, full, clipIds } = classify(patches);
      doc = next;
      if (full || change.structure) {
        rebuildStructure();
        return full ? { structure: true, clips: true, song: change.song } : change;
      }
      if (change.clips && clipIds !== null) {
        // Re-index the lane a clip LEFT as well as the one it arrived on.
        const targets = new Set<number>();
        for (const id of clipIds) {
          const before = clipRow.get(id);
          if (before !== undefined) targets.add(before);
          const after = rowOfChannelId.get(
            (next.clips[id] ?? next.audioClips[id])?.trackId ?? "",
          );
          if (after !== undefined) targets.add(after);
          if (next.clips[id] === undefined && next.audioClips[id] === undefined) {
            clipById.delete(id);
            clipRow.delete(id);
          }
        }
        fillRows(targets);
      }
      return change;
    },
  };

  return scene;
}
