// SS11 lane commands through the real store: invariants (sorted, one point
// per tick), undo round-trips, and the SS7 keep-and-rebind promise.

import { beforeEach, describe, expect, it } from "vitest";
import { makeFixture, type Fixture } from "../testing/fixture";
import { volumeParamId } from "../../params";

let f: Fixture;
let paramId: string;
beforeEach(() => {
  f = makeFixture();
  paramId = volumeParamId(f.trackId);
  f.store.dispatch(f.commands.addLane(f.trackId, paramId, { id: "lane-1" }));
});

describe("lane lifecycle", () => {
  it("addLane creates an enabled, empty lane on the channel", () => {
    const lane = f.store.getState().lanes["lane-1"];
    expect(lane).toEqual({ id: "lane-1", channelId: f.trackId, paramId, points: [], enabled: true });
  });

  it("addLane for an existing (channel, param) pair re-enables instead of duplicating", () => {
    f.store.dispatch(f.commands.setLaneEnabled("lane-1", false));
    f.store.dispatch(f.commands.addLane(f.trackId, paramId));
    const lanes = Object.values(f.store.getState().lanes);
    expect(lanes.length).toBe(1);
    expect(lanes[0]?.enabled).toBe(true);
  });

  it("deleteLanes removes; undo restores exactly", () => {
    const before = f.store.getState();
    f.store.dispatch(f.commands.deleteLanes(["lane-1"]));
    expect(f.store.getState().lanes["lane-1"]).toBeUndefined();
    f.store.undo();
    expect(f.store.getState()).toEqual(before);
  });

  it("rebindLane re-points the paramId, keeping every point (SS7)", () => {
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 0, v: -6 }));
    f.store.dispatch(f.commands.rebindLane("lane-1", volumeParamId(f.masterId)));
    const lane = f.store.getState().lanes["lane-1"];
    expect(lane?.paramId).toBe(volumeParamId(f.masterId));
    expect(lane?.points.length).toBe(1);
  });
});

describe("point editing", () => {
  it("points stay sorted and unique per tick; a same-tick add replaces", () => {
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 960, v: 1 }));
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 0, v: 2 }));
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 960, v: 3 }));
    const points = f.store.getState().lanes["lane-1"]?.points;
    expect(points).toEqual([
      { t: 0, v: 2, curve: 0 },
      { t: 960, v: 3, curve: 0 },
    ]);
  });

  it("moveLanePoints moves by tick key in ONE command, preserving curve", () => {
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 0, v: 0, curve: 0.5 }));
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 960, v: 6 }));
    f.store.dispatch(
      f.commands.moveLanePoints("lane-1", [
        { fromT: 0, toT: 240, v: -3 },
        { fromT: 960, toT: 1200, v: 3 },
      ]),
    );
    const points = f.store.getState().lanes["lane-1"]?.points;
    expect(points).toEqual([
      { t: 240, v: -3, curve: 0.5 },
      { t: 1200, v: 3, curve: 0 },
    ]);
    f.store.undo(); // ONE entry undoes the whole move
    expect(f.store.getState().lanes["lane-1"]?.points).toEqual([
      { t: 0, v: 0, curve: 0.5 },
      { t: 960, v: 6, curve: 0 },
    ]);
  });

  it("a move landing two points on one tick keeps the moved one", () => {
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 0, v: 1 }));
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 960, v: 2 }));
    f.store.dispatch(f.commands.moveLanePoints("lane-1", [{ fromT: 960, toT: 0, v: 2 }]));
    expect(f.store.getState().lanes["lane-1"]?.points).toEqual([{ t: 0, v: 2, curve: 0 }]);
  });

  it("deleteLanePoints removes by tick", () => {
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 0, v: 1 }));
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 960, v: 2 }));
    f.store.dispatch(f.commands.deleteLanePoints("lane-1", [0]));
    expect(f.store.getState().lanes["lane-1"]?.points).toEqual([{ t: 960, v: 2, curve: 0 }]);
  });

  it("setLaneSegmentCurve clamps to [-1, 1]", () => {
    f.store.dispatch(f.commands.addLanePoint("lane-1", { t: 0, v: 1 }));
    f.store.dispatch(f.commands.setLaneSegmentCurve("lane-1", 0, 4));
    expect(f.store.getState().lanes["lane-1"]?.points[0]?.curve).toBe(1);
  });
});
