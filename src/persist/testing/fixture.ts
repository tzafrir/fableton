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

/** Deep clone via JSON round-trip — good enough for a plain-data `Project`
 *  and keeps tests from accidentally sharing mutable state. */
export function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project;
}
