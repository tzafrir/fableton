// SS10 arrangement semantics: clip-relative notes, left-trim rewrite, split.

import { describe, expect, it } from "vitest";
import { MIN_CLIP_TICKS } from "../../types";
import { BAR, EIGHTH, QUARTER, makeFixture, notes } from "../testing/fixture";
import { expectLegalProject } from "../testing/invariants";

const clipOf = (f: ReturnType<typeof makeFixture>, id: string) => f.store.getState().clips[id];

describe("clip commands", () => {
  it("createClip mints ids eagerly and reports them through the patches", () => {
    const f = makeFixture();
    const result = f.store.dispatch(
      f.commands.createClip({ trackId: f.trackId, start: BAR, length: BAR, notes: notes([[0, 60]]) }),
    );
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    const patch = result.patches[0];
    expect(patch?.op).toBe("add");
    expect(patch?.path).toEqual(["clips", "clip-2"]);
    expect(clipOf(f, "clip-2")?.start).toBe(BAR);
  });

  it("createClip rejects an unknown or non-track destination", () => {
    const f = makeFixture();
    expect(f.store.dispatch(f.commands.createClip({ trackId: "nope", start: 0, length: BAR }))).toEqual({
      status: "rejected",
      reason: "That track no longer exists.",
    });
    expect(f.store.dispatch(f.commands.createClip({ trackId: f.masterId, start: 0, length: BAR }))).toEqual({
      status: "rejected",
      reason: "Clips can only live on tracks.",
    });
  });

  it("createClip floors length at MIN_CLIP_TICKS and start at 0", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.createClip({ id: "c", trackId: f.trackId, start: -100, length: 1 }));
    expect(clipOf(f, "c")).toMatchObject({ start: 0, length: MIN_CLIP_TICKS });
  });

  it("moveClips moves in ticks and in arrangement ROWS", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addTrack({ id: "chan-b", name: "Track 2" }));
    f.store.dispatch(f.commands.moveClips([f.clipId], { ticks: BAR, tracks: 1 }));
    expect(clipOf(f, f.clipId)?.start).toBe(BAR);
    expect(clipOf(f, f.clipId)?.trackId).toBe("chan-b");
  });

  it("moveClips never drops a clip onto the master row or off the top", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.moveClips([f.clipId], { ticks: 0, tracks: 5 }));
    expect(clipOf(f, f.clipId)?.trackId).toBe(f.trackId);
    f.store.dispatch(f.commands.moveClips([f.clipId], { ticks: 0, tracks: -3 }));
    expect(clipOf(f, f.clipId)?.trackId).toBe(f.trackId);
  });

  it("moveClips clamps the tick delta for the whole selection at once", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.createClip({ id: "late", trackId: f.trackId, start: BAR * 2, length: BAR }));
    f.store.dispatch(f.commands.moveClips([f.clipId, "late"], { ticks: -BAR, tracks: 0 }));
    expect(clipOf(f, f.clipId)?.start).toBe(0);
    expect(clipOf(f, "late")?.start).toBe(BAR * 2);
  });

  it("trimming the RIGHT edge only changes length", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60], [BAR - EIGHTH, 72]])));
    f.store.dispatch(f.commands.trimClips([{ id: f.clipId, start: 0, length: QUARTER }]));
    expect(clipOf(f, f.clipId)?.length).toBe(QUARTER);
    expect(clipOf(f, f.clipId)?.notes).toHaveLength(2);
  });

  // "Draw one bar, then stretch it over the arrangement" — the gesture a DAW
  // is expected to have, and the reason `loopAfterGrow` exists.
  describe("growing the right edge tiles the clip's content", () => {
    it("adds a brace over the OLD length when a clip with notes grows", () => {
      const f = makeFixture();
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
      f.store.dispatch(f.commands.trimClips([{ id: f.clipId, start: 0, length: BAR * 4 }]));
      expect(clipOf(f, f.clipId)).toMatchObject({ length: BAR * 4, loop: { start: 0, end: BAR } });
    });

    it("leaves an existing brace alone — the user already said what repeats", () => {
      const f = makeFixture();
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
      f.store.dispatch(f.commands.setClipLoop(f.clipId, { start: 0, end: QUARTER }));
      f.store.dispatch(f.commands.trimClips([{ id: f.clipId, start: 0, length: BAR * 4 }]));
      expect(clipOf(f, f.clipId)?.loop).toEqual({ start: 0, end: QUARTER });
    });

    it("leaves an EMPTY clip un-looped: stretching a blank clip makes room to draw", () => {
      const f = makeFixture();
      f.store.dispatch(f.commands.trimClips([{ id: f.clipId, start: 0, length: BAR * 4 }]));
      expect(clipOf(f, f.clipId)?.loop).toBeUndefined();
    });

    it("never loops on a shrink, and never on a LEFT-edge drag", () => {
      const f = makeFixture();
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
      f.store.dispatch(f.commands.trimClips([{ id: f.clipId, start: 0, length: QUARTER }]));
      expect(clipOf(f, f.clipId)?.loop).toBeUndefined();
      // Left edge outward: the clip grows, but its start moved, so the
      // content slid rather than repeated — tiling here would be a lie.
      f.store.dispatch(f.commands.moveClips([f.clipId], { ticks: BAR, tracks: 0 }));
      f.store.dispatch(f.commands.trimClips([{ id: f.clipId, start: 0, length: BAR + QUARTER }]));
      expect(clipOf(f, f.clipId)?.loop).toBeUndefined();
    });

    it("is one undo entry with the trim, not two", () => {
      const f = makeFixture();
      f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
      f.store.dispatch(f.commands.trimClips([{ id: f.clipId, start: 0, length: BAR * 4 }]));
      f.store.undo();
      expect(clipOf(f, f.clipId)).toMatchObject({ length: BAR });
      expect(clipOf(f, f.clipId)?.loop).toBeUndefined();
    });
  });

  it("trimming the LEFT edge rewrites note starts and drops what falls outside", () => {
    const f = makeFixture();
    f.store.dispatch(
      f.commands.addNotes(f.clipId, [
        { id: "dropped", start: 0, dur: EIGHTH, pitch: 60, vel: 100 },
        { id: "straddling", start: QUARTER - EIGHTH, dur: QUARTER, pitch: 62, vel: 100 },
        { id: "kept", start: QUARTER * 2, dur: EIGHTH, pitch: 64, vel: 100 },
      ]),
    );
    f.store.dispatch(f.commands.trimClips([{ id: f.clipId, start: QUARTER, length: BAR - QUARTER }]));
    const clip = clipOf(f, f.clipId);
    expect(clip?.start).toBe(QUARTER);
    expect(clip?.notes.map((note) => note.id)).toEqual(["straddling", "kept"]);
    // The straddling note is clipped to the new edge; the kept one slides.
    expect(clip?.notes[0]).toMatchObject({ start: 0, dur: QUARTER - EIGHTH });
    expect(clip?.notes[1]?.start).toBe(QUARTER);

    // The v1 note loss is undoable — that is the whole justification (SS13).
    f.store.undo();
    expect(clipOf(f, f.clipId)?.notes.map((note) => note.id)).toEqual(["dropped", "straddling", "kept"]);
  });

  it("splitClip cuts crossing notes in two and keeps both halves legal", () => {
    const f = makeFixture();
    f.store.dispatch(
      f.commands.addNotes(f.clipId, [
        { id: "long", start: 0, dur: BAR, pitch: 60, vel: 100 },
        { id: "late", start: QUARTER * 3, dur: EIGHTH, pitch: 72, vel: 100 },
      ]),
    );
    const result = f.store.dispatch(f.commands.splitClip(f.clipId, QUARTER * 2, "right"));
    expect(result.status).toBe("applied");

    const left = clipOf(f, f.clipId);
    const right = clipOf(f, "right");
    expect(left?.length).toBe(QUARTER * 2);
    expect(left?.notes).toEqual([{ id: "long", start: 0, dur: QUARTER * 2, pitch: 60, vel: 100 }]);
    expect(right?.start).toBe(QUARTER * 2);
    expect(right?.length).toBe(QUARTER * 2);
    expect(right?.notes).toEqual([
      { id: "long-b", start: 0, dur: QUARTER * 2, pitch: 60, vel: 100 },
      { id: "late", start: QUARTER, dur: EIGHTH, pitch: 72, vel: 100 },
    ]);
    expectLegalProject(structuredClone(f.store.getState()));
  });

  it("splitClip rejects a looped clip and an out-of-range cut", () => {
    const f = makeFixture();
    expect(f.store.dispatch(f.commands.splitClip(f.clipId, 0)).status).toBe("rejected");
    expect(f.store.dispatch(f.commands.splitClip(f.clipId, BAR)).status).toBe("rejected");
    expect(f.store.dispatch(f.commands.splitClip("gone", QUARTER)).status).toBe("rejected");

    f.store.dispatch(f.commands.setClipLoop(f.clipId, { start: 0, end: QUARTER }));
    expect(f.store.dispatch(f.commands.splitClip(f.clipId, QUARTER))).toEqual({
      status: "rejected",
      reason: "A looped clip cannot be split.",
    });
  });

  it("duplicateClips copies content, keeps note ids and applies the delta", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.addNotes(f.clipId, notes([[0, 60]])));
    f.store.dispatch(f.commands.duplicateClips([f.clipId], { ticks: BAR, tracks: 0 }, ["copy"]));
    expect(clipOf(f, "copy")).toMatchObject({ start: BAR, trackId: f.trackId });
    expect(clipOf(f, "copy")?.notes).toEqual(clipOf(f, f.clipId)?.notes);
  });

  it("setClipLoop stores clip-relative bounds and clears them with null", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.setClipLoop(f.clipId, { start: -10, end: 0 }));
    expect(clipOf(f, f.clipId)?.loop).toEqual({ start: 0, end: 1 });
    f.store.dispatch(f.commands.setClipLoop(f.clipId, null));
    expect(Object.hasOwn(clipOf(f, f.clipId) ?? {}, "loop")).toBe(false);
  });

  it("deleteClips removes only the named clips", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.createClip({ id: "other", trackId: f.trackId, start: BAR, length: BAR }));
    f.store.dispatch(f.commands.deleteClips([f.clipId]));
    expect(clipOf(f, f.clipId)).toBeUndefined();
    expect(clipOf(f, "other")).toBeDefined();
  });

  it("clip verbs on a missing clip are noops", () => {
    const { commands, store } = makeFixture();
    for (const command of [
      commands.deleteClips(["gone"]),
      commands.moveClips(["gone"], { ticks: 10, tracks: 0 }),
      commands.trimClips([{ id: "gone", start: 0, length: BAR }]),
      commands.duplicateClips(["gone"], { ticks: 10, tracks: 0 }),
      commands.setClipLoop("gone", null),
      commands.renameClip("gone", "x"),
      commands.setClipColor("gone", "#fff"),
    ]) {
      expect(store.dispatch(command).status).toBe("noop");
    }
  });
});
