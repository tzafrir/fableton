// Reading helpers the editors and the engine glue both want and neither
// should re-implement (types/commands `ClipsOfTrack` / `NotesOfClip`).
//
// Everything here takes the deep-readonly `ProjectSnapshot` the store hands
// out. Snapshots are structurally shared, so holding one across an edit is
// safe and cheap.

import type {
  ChannelId,
  Channel,
  ClipId,
  ClipsOfTrack,
  Immutable,
  MidiClip,
  Note,
  NotesOfClip,
  ParamId,
  ProjectSnapshot,
} from "../types";

const NO_CLIPS: readonly Immutable<MidiClip>[] = [];
const NO_NOTES: readonly Immutable<Note>[] = [];

function byStart(a: Immutable<MidiClip>, b: Immutable<MidiClip>): number {
  return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Clips of one track, in start order (ties broken by id so the order is
 *  total — the arrangement draws in this order and the scheduler walks it). */
export const clipsOfTrack: ClipsOfTrack = (doc: ProjectSnapshot, trackId: ChannelId) => {
  const out: Immutable<MidiClip>[] = [];
  for (const clip of Object.values(doc.clips)) {
    if (clip.trackId === trackId) out.push(clip);
  }
  if (out.length === 0) return NO_CLIPS;
  out.sort(byStart);
  return out;
};

/** The notes of a clip, already sorted by `(start, pitch)` (invariant 4), so
 *  the piano roll's culling can binary-search them (SS9). */
export const notesOfClip: NotesOfClip = (doc: ProjectSnapshot, clipId: ClipId) =>
  doc.clips[clipId]?.notes ?? NO_NOTES;

/** Channels in arrangement row order (invariant 2: row = index here). */
export function channelsInOrder(doc: ProjectSnapshot): readonly Immutable<Channel>[] {
  const out: Immutable<Channel>[] = [];
  for (const id of doc.channelOrder) {
    const channel = doc.channels[id];
    if (channel !== undefined) out.push(channel);
  }
  return out;
}

/** Just the `'track'` channels, in row order. */
export function tracksInOrder(doc: ProjectSnapshot): readonly Immutable<Channel>[] {
  return channelsInOrder(doc).filter((channel) => channel.role === "track");
}

/** Arrangement row of a channel, or `-1`. */
export function rowOfChannel(doc: ProjectSnapshot, channelId: ChannelId): number {
  return doc.channelOrder.indexOf(channelId);
}

/** The channel at an arrangement row, or `undefined`. */
export function channelAtRow(doc: ProjectSnapshot, row: number): Immutable<Channel> | undefined {
  const id = doc.channelOrder[row];
  return id === undefined ? undefined : doc.channels[id];
}

/**
 * The document's clips as MUTABLE plain objects, in start order — what M0's
 * `createClipEventSource` takes. The copy is deliberate and shallow-per-clip
 * (`{...clip, notes: [...clip.notes]}`): the source must never be handed the
 * frozen snapshot arrays, and the engine must never be able to write back into
 * the document (SS3: "the engine never reaches back into the document").
 *
 * Clips on muted channels are dropped here rather than in the event source:
 * M1 has no mixer yet, so mute has to mean something audible.
 */
export function clipsForEngine(doc: ProjectSnapshot): MidiClip[] {
  const out: MidiClip[] = [];
  for (const clip of Object.values(doc.clips)) {
    if (doc.channels[clip.trackId]?.mute === true) continue;
    out.push({ ...clip, notes: [...clip.notes] });
  }
  out.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * Every param that already has an automation lane.
 *
 * Asked once per control render (the right-click menu has to know whether it
 * is offering to ADD a lane or to SHOW one), which is why it is a set built
 * once rather than a scan per param: a device panel can hold forty controls
 * and a project any number of lanes, and the product of the two is a
 * per-frame cost for a menu that is almost never open.
 *
 * Keyed on the `lanes` record itself, so it is rebuilt only when a lane is
 * actually added or removed — every other edit hands back the same object,
 * structural sharing being the whole point of the snapshot.
 */
const laneParamCache = new WeakMap<object, ReadonlySet<ParamId>>();

export function automatedParamIds(doc: ProjectSnapshot): ReadonlySet<ParamId> {
  const lanes = doc.lanes;
  const cached = laneParamCache.get(lanes);
  if (cached !== undefined) return cached;
  const ids = new Set<ParamId>();
  for (const lane of Object.values(lanes)) {
    if (lane !== undefined) ids.add(lane.paramId);
  }
  laneParamCache.set(lanes, ids);
  return ids;
}
