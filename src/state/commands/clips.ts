// SS10 + SS6 — the arrangement's clip vocabulary. Clip `start` is an absolute
// song tick; note ticks inside a clip are clip-relative, so moving a clip
// never rewrites its notes (that is exactly why trimming the LEFT edge is the
// one verb that has to).

import type {
  AudioClip,
  AudioClipInit,
  ChannelId,
  ClipDelta,
  ClipId,
  ClipInit,
  ClipSpan,
  Command,
  IdFactory,
  MidiClip,
  Note,
  ProjectCommands,
  ProjectSnapshot,
  Ticks,
} from "../../types";
import { MIN_CLIP_TICKS, PPQ, loopAfterGrow } from "../../types";
import { noteFromInit } from "./notes";
import {
  MIN_NOTE_DUR_TICKS,
  clampRowDelta,
  clipOf,
  copyNote,
  makeCommand,
  sortNotes,
  sortNotesIfNeeded,
  tick,
  type DraftClip,
  type DraftProject,
} from "./util";

export type ClipCommands = Pick<
  ProjectCommands,
  | "createClip"
  | "deleteClips"
  | "moveClips"
  | "trimClips"
  | "splitClip"
  | "duplicateClips"
  | "createAudioClip"
  | "setClipLoop"
  | "renameClip"
  | "setClipColor"
>;

/**
 * The four fields every clip has wherever it lives, MIDI or audio: an id, a
 * lane, a start and a length.
 *
 * The arrangement moves, trims, duplicates, renames, recolours and deletes
 * both kinds with the same gesture and the same command, so the commands work
 * through this rather than through either map — and adding a third kind of
 * clip later would need no new verbs, only a new entry in `anyClipOf`.
 */
type PositionedClip = { id: ClipId; trackId: ChannelId; start: Ticks; length: Ticks };

/** Whichever map holds `clipId`. Ids are unique across both (document
 *  invariant), so at most one can answer. */
function anyClipOf(doc: DraftProject, clipId: ClipId): PositionedClip | undefined {
  return doc.clips[clipId] ?? doc.audioClips[clipId];
}

function anyClipsByIds(doc: DraftProject, clipIds: readonly ClipId[]): PositionedClip[] {
  const seen = new Set<ClipId>();
  const out: PositionedClip[] = [];
  for (const id of clipIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const clip = anyClipOf(doc, id);
    if (clip !== undefined) out.push(clip);
  }
  return out;
}

/**
 * Clamps a clip drag the way `clampNoteDelta` clamps a note drag: the whole
 * selection moves together or not at all. A row delta is legal only when every
 * clip lands on an existing channel whose role is `'track'` — clips do not
 * live on groups, returns or the master.
 */
function clampClipDelta(
  doc: DraftProject,
  clips: readonly PositionedClip[],
  delta: ClipDelta,
): ClipDelta {
  if (clips.length === 0) return { ticks: 0, tracks: 0 };
  let minStart = Number.POSITIVE_INFINITY;
  for (const clip of clips) if (clip.start < minStart) minStart = clip.start;
  const ticks = Math.max(tick(delta.ticks), -minStart);

  const rows = clips.map((clip) => doc.channelOrder.indexOf(clip.trackId));
  const rowIsTrack = (row: number): boolean => {
    const id = doc.channelOrder[row];
    return id !== undefined && doc.channels[id]?.role === "track";
  };
  const tracks = clampRowDelta(delta.tracks, (candidate) =>
    rows.every((row) => row < 0 || rowIsTrack(row + candidate)),
  );
  return { ticks, tracks };
}

function targetTrack(doc: DraftProject, clip: PositionedClip, rowDelta: number): ChannelId {
  if (rowDelta === 0) return clip.trackId;
  const row = doc.channelOrder.indexOf(clip.trackId);
  if (row < 0) return clip.trackId;
  return doc.channelOrder[row + rowDelta] ?? clip.trackId;
}

/** Plain deep copy of a clip's notes (drafts must not leak into a new value). */
function copyNotes(notes: readonly Note[]): Note[] {
  return notes.map((note) => copyNote(note, note.id));
}

export function createClipCommands(ids: IdFactory): ClipCommands {
  return {
    createClip(init: ClipInit): Command {
      const clipId = init.id ?? ids.clip();
      const notes = (init.notes ?? []).map((noteInit) => noteFromInit(noteInit, noteInit.id ?? ids.note()));
      sortNotes(notes);
      const start = Math.max(0, tick(init.start));
      const length = Math.max(MIN_CLIP_TICKS, tick(init.length));
      const loop = init.loop ?? null;
      const name = init.name;
      const color = init.color;
      return makeCommand(
        "Create Clip",
        (doc) => {
          const clip: MidiClip = { id: clipId, trackId: init.trackId, start, length, notes: notes.map((note) => ({ ...note })) };
          if (loop !== null) {
            clip.loop = { start: Math.max(0, tick(loop.start)), end: Math.max(1, tick(loop.end)) };
          }
          if (name !== undefined) clip.name = name;
          if (color !== undefined) clip.color = color;
          doc.clips[clipId] = clip;
        },
        {
          canRun: (doc: ProjectSnapshot): string | null => {
            if (doc.channels[init.trackId] === undefined) return "That track no longer exists.";
            if (doc.channels[init.trackId]?.role !== "track") return "Clips can only live on tracks.";
            if (doc.clips[clipId] !== undefined) return "A clip with that id already exists.";
            return null;
          },
        },
      );
    },

    createAudioClip(init: AudioClipInit): Command {
      const clipId = init.id ?? ids.clip();
      const start = Math.max(0, tick(init.start));
      const length = Math.max(MIN_CLIP_TICKS, tick(init.length));
      const offsetFrames = Math.max(0, Math.round(init.offsetFrames ?? 0));
      const gainDb = init.gainDb ?? 0;
      const name = init.name;
      return makeCommand(
        "Add Audio Clip",
        (doc) => {
          const clip: AudioClip = {
            kind: "audio",
            id: clipId,
            trackId: init.trackId,
            start,
            length,
            assetId: init.assetId,
            offsetFrames,
            gainDb,
          };
          if (name !== undefined) clip.name = name;
          doc.audioClips[clipId] = clip;
        },
        {
          canRun: (doc) => {
            if (doc.channels[init.trackId] === undefined) return "That track no longer exists.";
            if (doc.channels[init.trackId]?.role !== "track") return "Clips can only live on tracks.";
            if (doc.assets[init.assetId] === undefined) return "That sample is not in this project.";
            if (doc.clips[clipId] !== undefined || doc.audioClips[clipId] !== undefined) {
              return "A clip with that id already exists.";
            }
            return null;
          },
        },
      );
    },

    deleteClips(clipIds: readonly ClipId[]): Command {
      return makeCommand(clipIds.length === 1 ? "Delete Clip" : "Delete Clips", (doc) => {
        for (const id of clipIds) {
          if (doc.clips[id] !== undefined) delete doc.clips[id];
          else if (doc.audioClips[id] !== undefined) delete doc.audioClips[id];
        }
      });
    },

    moveClips(clipIds: readonly ClipId[], delta: ClipDelta): Command {
      return makeCommand("Move Clips", (doc) => {
        const clips = anyClipsByIds(doc, clipIds);
        if (clips.length === 0) return;
        const clamped = clampClipDelta(doc, clips, delta);
        if (clamped.ticks === 0 && clamped.tracks === 0) return;
        // Resolve every destination BEFORE writing: `targetTrack` reads
        // `channelOrder`, which this loop does not touch, but the clip's own
        // `trackId` is about to change.
        const moves = clips.map((clip) => ({ clip, trackId: targetTrack(doc, clip, clamped.tracks) }));
        for (const move of moves) {
          move.clip.start += clamped.ticks;
          move.clip.trackId = move.trackId;
        }
      });
    },

    trimClips(spans: readonly ClipSpan[]): Command {
      return makeCommand("Trim Clips", (doc) => {
        for (const span of spans) {
          const audio = doc.audioClips[span.id];
          if (audio !== undefined) {
            const newStart = Math.max(0, tick(span.start));
            const newLength = Math.max(MIN_CLIP_TICKS, tick(span.length));
            const shift = newStart - audio.start;
            audio.start = newStart;
            audio.length = newLength;
            // The LEFT edge moved, so the same amount of MUSIC has to come
            // off the front of the file: an audio clip's content is pinned to
            // its start the way a MIDI clip's notes are. Frames per tick
            // comes from the asset's own rate and the tempo at the clip —
            // close enough at any single tempo, and the alternative (a
            // tempo-map integral per trim) buys precision no ear can hear on
            // a drag.
            if (shift !== 0) {
              const asset = doc.assets[audio.assetId];
              const bpm = doc.tempo[0]?.bpm ?? 120;
              const framesPerTick =
                asset === undefined ? 0 : (asset.sampleRate * 60) / (bpm * PPQ);
              audio.offsetFrames = Math.max(
                0,
                Math.round(audio.offsetFrames + shift * framesPerTick),
              );
            }
            continue;
          }
          const clip = clipOf(doc, span.id);
          if (clip === undefined) continue;
          const newStart = Math.max(0, tick(span.start));
          const newLength = Math.max(MIN_CLIP_TICKS, tick(span.length));
          const shift = newStart - clip.start;
          const previousLength = clip.length;
          clip.start = newStart;
          clip.length = newLength;
          if (shift === 0) {
            // The RIGHT edge grew: tile what is already there rather than
            // appending silence (types/editor `loopAfterGrow` states the rule
            // and why, and the arrangement's ghost predicts it from the same
            // function so the preview cannot disagree with the release).
            const grown = loopAfterGrow({
              previousLength,
              newLength,
              hasLoop: clip.loop !== undefined && clip.loop !== null,
              hasNotes: clip.notes.length > 0,
            });
            if (grown !== null) clip.loop = { start: grown.start, end: grown.end };
            continue;
          }
          // The LEFT edge moved. Note ticks are clip-relative, so the content
          // slides the other way; content pushed outside the new window is
          // dropped (the accepted v1 loss — undo restores it exactly).
          for (let i = clip.notes.length - 1; i >= 0; i--) {
            const note = clip.notes[i];
            if (note === undefined) continue;
            const start = note.start - shift;
            const end = start + note.dur;
            if (end <= 0 || start >= newLength) {
              clip.notes.splice(i, 1);
              continue;
            }
            if (start < 0) {
              // Straddles the new left edge: clip it to the edge.
              note.start = 0;
              note.dur = Math.max(MIN_NOTE_DUR_TICKS, end);
            } else {
              note.start = start;
            }
          }
          sortNotesIfNeeded(clip.notes);
          const loop = clip.loop;
          if (loop !== undefined) {
            const loopStart = Math.max(0, loop.start - shift);
            const loopEnd = Math.min(newLength, loop.end - shift);
            if (loopEnd - loopStart < 1) delete clip.loop;
            else {
              loop.start = loopStart;
              loop.end = loopEnd;
            }
          }
        }
      });
    },

    splitClip(clipId: ClipId, atTick: Ticks, newClipId?: ClipId | undefined): Command {
      const rightId = newClipId ?? ids.clip();
      const cut = tick(atTick);
      return makeCommand(
        "Split Clip",
        (doc) => {
          const clip = clipOf(doc, clipId);
          if (clip === undefined) return;
          const cutRel = cut - clip.start;
          if (cutRel <= 0 || cutRel >= clip.length) return;
          const rightNotes: Note[] = [];
          const taken = new Set(clip.notes.map((note) => note.id));
          for (let i = clip.notes.length - 1; i >= 0; i--) {
            const note = clip.notes[i];
            if (note === undefined) continue;
            if (note.start >= cutRel) {
              const moved = copyNote(note, note.id);
              moved.start -= cutRel;
              rightNotes.push(moved);
              clip.notes.splice(i, 1);
              continue;
            }
            const end = note.start + note.dur;
            if (end <= cutRel) continue;
            // Crossing the cut: the head stays, the tail becomes a new note.
            // Its id is DERIVED from the head's, not minted, so `run` stays a
            // pure function of the document (the number of crossing notes is
            // not knowable when the factory runs).
            let tailId = `${note.id}-b`;
            while (taken.has(tailId)) tailId = `${tailId}b`;
            taken.add(tailId);
            const tail = copyNote(note, tailId);
            tail.start = 0;
            tail.dur = end - cutRel;
            rightNotes.push(tail);
            note.dur = cutRel - note.start;
          }
          sortNotes(rightNotes);
          sortNotesIfNeeded(clip.notes);
          const right: MidiClip = {
            id: rightId,
            trackId: clip.trackId,
            start: clip.start + cutRel,
            length: clip.length - cutRel,
            notes: rightNotes,
          };
          if (clip.name !== undefined) right.name = clip.name;
          if (clip.color !== undefined) right.color = clip.color;
          clip.length = cutRel;
          doc.clips[rightId] = right;
        },
        {
          canRun: (doc: ProjectSnapshot): string | null => {
            const clip = doc.clips[clipId];
            if (clip === undefined) return "That clip no longer exists.";
            // Unrolled loop content has no single split point (SS10).
            if (clip.loop !== undefined && clip.loop !== null) return "A looped clip cannot be split.";
            const cutRel = cut - clip.start;
            if (cutRel <= 0 || cutRel >= clip.length) return "The split point is outside the clip.";
            return null;
          },
        },
      );
    },

    duplicateClips(
      clipIds: readonly ClipId[],
      delta: ClipDelta,
      newIds?: readonly ClipId[] | undefined,
    ): Command {
      const minted = clipIds.map((_, i) => newIds?.[i] ?? ids.clip());
      return makeCommand("Duplicate Clips", (doc) => {
        // Audio clips duplicate too, and by the same gesture — the copy is a
        // second reference to the same asset, not a second copy of the file.
        const audioSources = clipIds
          .map((id, i) => ({ clip: doc.audioClips[id], id: minted[i] }))
          .filter(
            (entry): entry is { clip: NonNullable<typeof entry.clip>; id: ClipId } =>
              entry.clip !== undefined && entry.id !== undefined,
          );
        const sources = clipIds
          .map((id, i) => ({ clip: doc.clips[id], id: minted[i] }))
          .filter((entry): entry is { clip: DraftClip; id: ClipId } => entry.clip !== undefined && entry.id !== undefined);
        if (sources.length === 0 && audioSources.length === 0) return;
        const clamped = clampClipDelta(
          doc,
          [...sources, ...audioSources].map((entry) => entry.clip),
          delta,
        );
        for (const entry of audioSources) {
          if (doc.clips[entry.id] !== undefined || doc.audioClips[entry.id] !== undefined) continue;
          const source = entry.clip;
          const copy: AudioClip = {
            kind: "audio",
            id: entry.id,
            trackId: targetTrack(doc, source, clamped.tracks),
            start: Math.max(0, source.start + clamped.ticks),
            length: source.length,
            assetId: source.assetId,
            offsetFrames: source.offsetFrames,
            gainDb: source.gainDb,
          };
          if (source.name !== undefined) copy.name = source.name;
          if (source.color !== undefined && source.color !== null) copy.color = source.color;
          doc.audioClips[entry.id] = copy;
        }
        for (const entry of sources) {
          if (doc.clips[entry.id] !== undefined) continue;
          const source = entry.clip;
          // Note ids only have to be unique WITHIN a clip, so the copies keep
          // theirs — nothing else in the document references a note.
          const copy: MidiClip = {
            id: entry.id,
            trackId: targetTrack(doc, source, clamped.tracks),
            start: Math.max(0, source.start + clamped.ticks),
            length: source.length,
            notes: copyNotes(source.notes),
          };
          if (source.loop !== undefined) copy.loop = { start: source.loop.start, end: source.loop.end };
          if (source.name !== undefined) copy.name = source.name;
          if (source.color !== undefined) copy.color = source.color;
          doc.clips[entry.id] = copy;
        }
      });
    },

    setClipLoop(clipId: ClipId, loop: { start: Ticks; end: Ticks } | null): Command {
      return makeCommand(loop === null ? "Clear Clip Loop" : "Set Clip Loop", (doc) => {
        const clip = clipOf(doc, clipId);
        if (clip === undefined) return;
        if (loop === null) {
          if (clip.loop !== undefined) delete clip.loop;
          return;
        }
        const start = Math.max(0, tick(loop.start));
        const end = Math.max(start + 1, tick(loop.end));
        if (clip.loop === undefined) clip.loop = { start, end };
        else {
          clip.loop.start = start;
          clip.loop.end = end;
        }
      });
    },

    renameClip(clipId: ClipId, name: string): Command {
      return makeCommand(
        "Rename Clip",
        (doc) => {
          const clip = doc.clips[clipId] ?? doc.audioClips[clipId];
          if (clip === undefined) return;
          clip.name = name;
        },
        // Typing in the name field is one undo entry, not one per keystroke.
        { coalesceKey: `clip.name:${clipId}` },
      );
    },

    setClipColor(clipId: ClipId, color: string | null): Command {
      return makeCommand("Set Clip Color", (doc) => {
        const clip = doc.clips[clipId] ?? doc.audioClips[clipId];
        if (clip === undefined) return;
        clip.color = color;
      });
    },
  };
}
