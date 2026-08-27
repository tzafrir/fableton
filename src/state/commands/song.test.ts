import { describe, expect, it } from "vitest";
import { MAX_BPM, MIN_BPM } from "./song";
import { BAR, makeFixture } from "../testing/fixture";
import { expectLegalProject } from "../testing/invariants";

describe("song commands", () => {
  it("setParamValue stores REAL units under the full ParamId", () => {
    const f = makeFixture();
    const id = `chan:${f.trackId}/vol`;
    f.store.dispatch(f.commands.setParamValue(id, -6.5));
    expect(f.store.getState().paramValues[id]).toBe(-6.5);
  });

  it("setParamValue ignores a non-finite value", () => {
    const f = makeFixture();
    expect(f.store.dispatch(f.commands.setParamValue("chan:x/vol", Number.NaN)).status).toBe("noop");
  });

  it("setParamValues writes a whole bag at once (one undo entry)", () => {
    const f = makeFixture();
    f.store.dispatch(
      f.commands.setParamValues({ [`chan:${f.trackId}/vol`]: -3, [`chan:${f.masterId}/vol`]: -1 }),
    );
    expect(f.store.history()).toHaveLength(1);
    expect(f.store.getState().paramValues[`chan:${f.trackId}/vol`]).toBe(-3);
  });

  it("setTempo keeps a single segment starting at tick 0 (invariant 1)", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.setTempo(174));
    expect(f.store.getState().tempo).toEqual([{ startTick: 0, bpm: 174 }]);
    f.store.dispatch(f.commands.setTempo(1e6));
    expect(f.store.getState().tempo[0]?.bpm).toBe(MAX_BPM);
    f.store.dispatch(f.commands.setTempo(0));
    expect(f.store.getState().tempo[0]?.bpm).toBe(MIN_BPM);
    expectLegalProject(structuredClone(f.store.getState()));
  });

  it("setTimeSignature rounds and floors both halves", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.setTimeSignature({ numerator: 6, denominator: 8 }));
    expect(f.store.getState().timeSignature).toEqual({ numerator: 6, denominator: 8 });
    f.store.dispatch(f.commands.setTimeSignature({ numerator: 0, denominator: -4 }));
    expect(f.store.getState().timeSignature).toEqual({ numerator: 1, denominator: 1 });
  });

  it("setLoopRegion keeps end >= start and start >= 0", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.setLoopRegion({ start: -100, end: -200, enabled: true }));
    expect(f.store.getState().loop).toEqual({ start: 0, end: 0, enabled: true });
    f.store.dispatch(f.commands.setLoopRegion({ start: BAR, end: BAR * 2, enabled: false }));
    expect(f.store.getState().loop).toEqual({ start: BAR, end: BAR * 2, enabled: false });
  });

  it("renameProject coalesces keystrokes into one undo entry", () => {
    const f = makeFixture();
    f.store.dispatch(f.commands.renameProject("S"));
    f.store.dispatch(f.commands.renameProject("So"));
    f.store.dispatch(f.commands.renameProject("Song"));
    expect(f.store.history()).toHaveLength(1);
    f.store.undo();
    expect(f.store.getState().name).toBe("Fixture");
  });

  it("custom is a full-power escape hatch that still produces patches", () => {
    const f = makeFixture();
    const result = f.store.dispatch(
      f.commands.custom("Rename Everything", (doc) => {
        doc.name = "X";
        for (const channel of Object.values(doc.channels)) channel.name = "Y";
      }),
    );
    expect(result.status).toBe("applied");
    expect(f.store.undoLabel()).toBe("Rename Everything");
    f.store.undo();
    expect(f.store.getState().name).toBe("Fixture");
  });
});
