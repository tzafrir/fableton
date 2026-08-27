// SS13 end to end: after an arbitrary storm of commands the document is still
// legal, unwinding the whole history reproduces the starting document exactly,
// and replaying it reproduces the end state exactly.
//
// This is the test that would catch a command that "works" but leaves the
// notes unsorted, an orphan device behind, or a patch that does not invert.

import { describe, expect, it } from "vitest";
import type { Command, Project } from "../types";
import { checkProjectInvariants } from "./testing/invariants";
import { BAR, EIGHTH, QUARTER, SIXTEENTH, makeFixture } from "./testing/fixture";

/** Tiny deterministic PRNG — a failing seed is a reproducible bug report. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("command storm", () => {
  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`seed ${seed}: stays legal, unwinds exactly and replays exactly`, () => {
      const f = makeFixture();
      const random = rng(seed);
      const pick = <T>(items: readonly T[]): T => {
        const item = items[Math.floor(random() * items.length)];
        if (item === undefined) throw new Error("empty pick");
        return item;
      };
      const int = (max: number): number => Math.floor(random() * max);

      const initial = structuredClone(f.store.getState()) as Project;
      const { commands, store } = f;

      for (let step = 0; step < 120; step++) {
        const doc = store.getState();
        const clipIds = Object.keys(doc.clips);
        const trackIds = doc.channelOrder.filter((id) => doc.channels[id]?.role === "track");
        const clipId = clipIds.length > 0 ? pick(clipIds) : "none";
        const noteIds = (doc.clips[clipId]?.notes ?? []).map((note) => note.id);
        const someNotes = noteIds.filter(() => random() < 0.5);
        const paramIds = Object.keys(doc.paramValues);
        const paramId = paramIds.length > 0 ? pick(paramIds) : "chan:x/vol";
        const laneIds = Object.keys(doc.lanes);
        const laneId = laneIds.length > 0 ? pick(laneIds) : "none";
        const lanePoints = doc.lanes[laneId]?.points ?? [];

        const choices: Command[] = [
          commands.addNotes(clipId, [
            { start: int(BAR), dur: int(QUARTER) + 1, pitch: int(128), vel: int(127) + 1 },
            { start: int(BAR), dur: int(QUARTER) + 1, pitch: int(128), vel: int(127) + 1 },
          ]),
          commands.deleteNotes(clipId, someNotes),
          commands.moveNotes(clipId, someNotes, { ticks: int(BAR) - QUARTER, pitch: int(24) - 12 }),
          commands.resizeNotes(
            clipId,
            someNotes.map((id) => ({ id, start: int(BAR), dur: int(QUARTER) })),
          ),
          commands.setNoteVelocities(
            clipId,
            someNotes.map((id) => ({ id, vel: int(200) })),
          ),
          commands.setNotesMuted(clipId, someNotes, random() < 0.5),
          commands.duplicateNotes(clipId, someNotes, { ticks: int(BAR), pitch: int(12) }),
          commands.quantizeNoteStarts(clipId, someNotes, pick([SIXTEENTH, EIGHTH, QUARTER])),
          commands.createClip({ trackId: trackIds.length > 0 ? pick(trackIds) : "none", start: int(BAR * 4), length: int(BAR) + 1 }),
          commands.deleteClips([clipId]),
          commands.moveClips([clipId], { ticks: int(BAR * 2) - BAR, tracks: int(3) - 1 }),
          commands.trimClips([{ id: clipId, start: int(BAR), length: int(BAR) + 1 }]),
          commands.splitClip(clipId, int(BAR * 2)),
          commands.duplicateClips([clipId], { ticks: int(BAR) + 1, tracks: int(3) - 1 }),
          commands.setClipLoop(clipId, random() < 0.5 ? null : { start: int(QUARTER), end: int(BAR) + 1 }),
          commands.renameClip(clipId, `clip ${step}`),
          commands.setClipColor(clipId, random() < 0.5 ? null : "#123456"),
          commands.addTrack(random() < 0.5 ? {} : { instrument: { definitionId: "core.poly-synth" } }),
          commands.deleteTracks(trackIds.filter(() => random() < 0.4)),
          commands.renameChannel(trackIds.length > 0 ? pick(trackIds) : "none", `track ${step}`),
          commands.moveChannel(pick(doc.channelOrder), int(doc.channelOrder.length + 1)),
          commands.setChannelMuted(trackIds.length > 0 ? pick(trackIds) : "none", random() < 0.5),
          commands.setChannelSolo(trackIds.length > 0 ? pick(trackIds) : "none", random() < 0.5),
          commands.setParamValue(paramIds.length > 0 ? pick(paramIds) : "chan:x/vol", random() * 24 - 12),
          commands.setTempo(60 + int(150)),
          commands.setLoopRegion({ start: int(BAR * 2), end: int(BAR * 4), enabled: random() < 0.5 }),
          commands.renameProject(`song ${step}`),
          // M2 routing + M3 lanes in the storm: `deleteChannels` is the verb
          // the mixer's Delete button dispatches, and it has to sweep the same
          // dependents `deleteTracks` does (clips, devices, sends, sidechains,
          // params AND lanes) or it leaves a document the codec truncates on
          // the next load.
          commands.addGroup(trackIds.filter(() => random() < 0.4)),
          commands.addReturn(),
          commands.deleteChannels(doc.channelOrder.filter(() => random() < 0.2)),
          commands.setChannelOutput(pick(doc.channelOrder), pick(doc.channelOrder)),
          commands.addLane(pick(doc.channelOrder), paramId),
          commands.addLanePoint(laneId, { t: int(BAR * 2), v: random() * 24 - 12, curve: random() * 2 - 1 }),
          commands.moveLanePoints(
            laneId,
            lanePoints
              .filter(() => random() < 0.5)
              .map((point) => ({ fromT: point.t, toT: int(BAR * 2), v: random() * 24 - 12 })),
          ),
          commands.deleteLanePoints(laneId, lanePoints.filter(() => random() < 0.3).map((point) => point.t)),
          commands.deleteLanes(laneIds.filter(() => random() < 0.2)),
        ];

        store.dispatch(pick(choices));
        const problems = checkProjectInvariants(structuredClone(store.getState()) as Project);
        expect(problems, `seed ${seed}, step ${step}`).toEqual([]);
      }

      const end = structuredClone(store.getState()) as Project;
      const depth = store.history().length;
      expect(depth).toBeGreaterThan(20);

      while (store.canUndo()) store.undo();
      expect(JSON.stringify(store.getState())).toBe(JSON.stringify(initial));

      while (store.canRedo()) store.redo();
      expect(JSON.stringify(store.getState())).toBe(JSON.stringify(end));
    });
  }
});

describe("patch stream", () => {
  it("addresses exactly the thing that changed (SS13 targeted updates)", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, [{ id: "a", start: 0, dur: EIGHTH, pitch: 60, vel: 100 }]));

    const move = f.store.dispatch(f.commands.moveNotes(f.clipId, ["a"], { ticks: QUARTER, pitch: 0 }));
    if (move.status !== "applied") throw new Error("expected applied");
    expect(move.patches).toEqual([
      { op: "replace", path: ["clips", f.clipId, "notes", 0, "start"], value: QUARTER },
    ]);

    const velocity = f.store.dispatch(f.commands.setNoteVelocities(f.clipId, [{ id: "a", vel: 40 }]));
    if (velocity.status !== "applied") throw new Error("expected applied");
    expect(velocity.patches).toEqual([
      { op: "replace", path: ["clips", f.clipId, "notes", 0, "vel"], value: 40 },
    ]);

    // A mixer param write touches one key of one map — not the channel.
    const param = f.store.dispatch(f.commands.setParamValue(`chan:${f.trackId}/vol`, -4));
    if (param.status !== "applied") throw new Error("expected applied");
    expect(param.patches).toEqual([
      { op: "replace", path: ["paramValues", `chan:${f.trackId}/vol`], value: -4 },
    ]);
  });

  it("reports a chain reorder as a chain-scoped patch (the SS13 example)", () => {
    const f = makeFixture();
    f.store.dispatch(
      f.commands.custom("Add Effects", (doc) => {
        const channel = doc.channels[f.trackId];
        if (channel === undefined) return;
        channel.chain.push("dev-a", "dev-b", "dev-c");
        doc.devices["dev-a"] = { id: "dev-a", definitionId: "core.filter", version: 1, channelId: f.trackId, enabled: true };
        doc.devices["dev-b"] = { id: "dev-b", definitionId: "core.filter", version: 1, channelId: f.trackId, enabled: true };
        doc.devices["dev-c"] = { id: "dev-c", definitionId: "core.filter", version: 1, channelId: f.trackId, enabled: true };
      }),
    );

    const result = f.store.dispatch(
      f.commands.custom("Move Effect", (doc) => {
        const chain = doc.channels[f.trackId]?.chain;
        if (chain === undefined) return;
        chain.unshift(...chain.splice(2, 1));
      }),
    );
    if (result.status !== "applied") throw new Error("expected applied");
    for (const patch of result.patches) {
      expect(patch.path.slice(0, 3)).toEqual(["channels", f.trackId, "chain"]);
    }
  });
});
