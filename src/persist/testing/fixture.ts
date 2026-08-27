// A small, self-contained `Project` fixture for this package's tests.
//
// Deliberately NOT built via `command-undo`'s `createEmptyProject` — that
// package is being written concurrently in the same wave (see the
// persistence work package's file-ownership note) and this package must not
// import from it. Every field is written out by hand instead, which also
// means this fixture doubles as a plain-data example of every ./document
// shape the codec has to round-trip.

import type { Project } from "../../types";

export const MASTER_ID = "chan-master";
export const TRACK_ID = "chan-track-1";
export const DEVICE_ID = "dev-synth-1";
export const CLIP_ID = "clip-1";

/** A fresh fixture project. Notes are deliberately NOT pre-sorted by
 *  `(start, pitch)` so tests can see `validate`/`decode` repair them. */
export function makeFixtureProject(): Project {
  return {
    id: "proj-fixture",
    name: "Fixture Song",
    tempo: [{ startTick: 0, bpm: 120 }],
    timeSignature: { numerator: 4, denominator: 4 },
    loop: { start: 0, end: 3840, enabled: false },
    channelOrder: [TRACK_ID, MASTER_ID],
    channels: {
      [MASTER_ID]: {
        id: MASTER_ID,
        role: "master",
        name: "Master",
        color: null,
        source: null,
        chain: [],
        volume: `chan:${MASTER_ID}/vol`,
        pan: `chan:${MASTER_ID}/pan`,
        mute: false,
        solo: false,
        sends: [],
        output: null,
      },
      [TRACK_ID]: {
        id: TRACK_ID,
        role: "track",
        name: "Synth",
        color: "#4488ff",
        source: { kind: "instrument", deviceId: DEVICE_ID },
        chain: [],
        volume: `chan:${TRACK_ID}/vol`,
        pan: `chan:${TRACK_ID}/pan`,
        mute: false,
        solo: false,
        sends: [{ to: MASTER_ID, amount: `chan:${TRACK_ID}/send:${MASTER_ID}`, tap: "post" }],
        output: MASTER_ID,
      },
    },
    devices: {
      [DEVICE_ID]: {
        id: DEVICE_ID,
        definitionId: "core.poly-synth",
        version: 1,
        channelId: TRACK_ID,
        enabled: true,
      },
    },
    clips: {
      [CLIP_ID]: {
        id: CLIP_ID,
        trackId: TRACK_ID,
        start: 0,
        length: 3840,
        notes: [
          { id: "note-2", start: 480, dur: 240, pitch: 67, vel: 100 },
          { id: "note-1", start: 0, dur: 480, pitch: 64, vel: 90 },
          { id: "note-3", start: 0, dur: 480, pitch: 60, vel: 100 },
        ],
        name: "Head",
        color: null,
      },
    },
    lanes: {},
    sidechains: [
      {
        from: { channel: TRACK_ID, tap: "postFx" },
        to: { device: DEVICE_ID, port: "sc" },
      },
    ],
    paramValues: {
      [`chan:${MASTER_ID}/vol`]: 0,
      [`chan:${MASTER_ID}/pan`]: 0,
      [`chan:${TRACK_ID}/vol`]: -3,
      [`chan:${TRACK_ID}/pan`]: 0,
      [`chan:${TRACK_ID}/send:${MASTER_ID}`]: 0,
    },
  };
}

export const FX_DEVICE_ID = "dev-filter-1";
export const LANE_ID = "lane-1";
export const LOOP_CLIP_ID = "clip-2";

/**
 * The fixture above, plus every document shape the plain one leaves out:
 * `clip.loop`, a muted note, a non-null `clip.color`, a non-empty
 * `channel.chain`, and a non-empty `lanes` map. ./document.ts is explicit
 * that "M1 ships `lanes: {}` and must round-trip whatever it loads
 * untouched", which is exactly the kind of field that rots silently unless a
 * test carries it.
 */
export function makeRichFixtureProject(): Project {
  const base = makeFixtureProject();
  const track = base.channels[TRACK_ID]!;
  return {
    ...base,
    channels: {
      ...base.channels,
      [TRACK_ID]: { ...track, chain: [FX_DEVICE_ID] },
    },
    devices: {
      ...base.devices,
      [FX_DEVICE_ID]: {
        id: FX_DEVICE_ID,
        definitionId: "core.filter",
        version: 1,
        channelId: TRACK_ID,
        enabled: false,
      },
    },
    clips: {
      ...base.clips,
      [LOOP_CLIP_ID]: {
        id: LOOP_CLIP_ID,
        trackId: TRACK_ID,
        start: 3840,
        length: 7680,
        loop: { start: 0, end: 1920 },
        notes: [
          { id: "note-4", start: 0, dur: 240, pitch: 48, vel: 64 },
          { id: "note-5", start: 240, dur: 240, pitch: 50, vel: 127, muted: true },
        ],
        name: "Looped",
        color: "#ff8800",
      },
    },
    lanes: {
      [LANE_ID]: {
        id: LANE_ID,
        channelId: TRACK_ID,
        paramId: `chan:${TRACK_ID}/vol`,
        points: [
          { t: 0, v: -6, curve: 0 },
          { t: 1920, v: 0, curve: 0.5 },
        ],
        enabled: true,
      },
    },
    paramValues: {
      ...base.paramValues,
      [`chan:${TRACK_ID}/dev:${FX_DEVICE_ID}/cutoff`]: 800,
    },
  };
}

/** Deep clone via JSON round-trip — good enough for a plain-data `Project`
 *  and keeps tests from accidentally sharing mutable state. */
export function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project;
}
