// SS7 racks through the file format: racks are ADDITIVE (a file written
// before they existed loads with `racks: {}` and no warning), they survive a
// round trip byte-for-byte, and the load-time repair fixes the structural
// mistakes only racks can make.

import { describe, expect, it } from "vitest";
import { projectCodec as codec } from "./codec";
import { makeFixtureProject, TRACK_ID } from "./testing/fixture";
import { rackChainParamId } from "../params";
import { checkProjectInvariants } from "../state/testing/invariants";
import type { DecodeResult, Project, RackState } from "../types";

/** `decode` returns a union; every probe here expects the success arm. */
function loaded(result: DecodeResult): { project: Project; warnings: readonly { path: string }[] } {
  if (!("project" in result)) throw new Error(`decode failed: ${result.error}`);
  return { project: result.project as Project, warnings: result.warnings ?? [] };
}

const RACK_ID = "rack-1";
const CHAIN_ID = "rchain-1";

function rack(over: Partial<RackState> = {}): RackState {
  return {
    id: RACK_ID,
    channelId: TRACK_ID,
    name: "Gated Verb",
    enabled: true,
    chains: [
      {
        id: CHAIN_ID,
        name: "Chain 1",
        devices: [],
        mute: false,
        solo: false,
        gain: rackChainParamId(TRACK_ID, RACK_ID, CHAIN_ID, "gain"),
        pan: rackChainParamId(TRACK_ID, RACK_ID, CHAIN_ID, "pan"),
      },
    ],
    macros: [],
    ...over,
  };
}

/** The fixture with a rack occupying a slot of the track's chain. */
function withRack(over: Partial<RackState> = {}): Project {
  const project = makeFixtureProject();
  const channel = project.channels[TRACK_ID];
  if (channel === undefined) throw new Error("fixture changed");
  const state = rack(over);
  project.racks[RACK_ID] = state;
  channel.chain = [...channel.chain, RACK_ID];
  project.paramValues[state.chains[0]?.gain ?? ""] = 0;
  project.paramValues[state.chains[0]?.pan ?? ""] = 0;
  return project;
}

describe("racks in the project file", () => {
  it("round-trips a rack unchanged", () => {
    const project = withRack();
    const decoded = loaded(codec.decode(codec.encode(project)));
    // (The shared fixture deliberately carries UNSORTED notes for the
    // codec's repair tests, so invariants are checked on the loaded copy.)
    expect(checkProjectInvariants(decoded.project)).toEqual([]);
    expect(decoded.project.racks).toEqual(project.racks);
    // And re-encoding is byte-stable, so autosave does not churn the file.
    expect(codec.encode(decoded.project, { savedAt: "x" })).toBe(
      codec.encode(project, { savedAt: "x" }),
    );
  });

  it("loads a file written before racks existed, silently", () => {
    const project = makeFixtureProject();
    const raw = JSON.parse(codec.encode(project)) as { racks?: unknown };
    delete raw.racks;
    const decoded = loaded(codec.decode(JSON.stringify(raw)));
    expect(decoded.project.racks).toEqual({});
    expect(decoded.warnings.some((w) => w.path.startsWith("racks"))).not.toBe(true);
  });

  it("drops a rack no chain slot references, with its devices", () => {
    const project = withRack();
    const channel = project.channels[TRACK_ID];
    if (channel === undefined) throw new Error("fixture changed");
    // Unreferenced: unreachable in the UI, silent in the graph, and it would
    // break invariant 8 on every later save.
    channel.chain = channel.chain.filter((id) => id !== RACK_ID);
    const decoded = loaded(codec.decode(codec.encode(project)));
    expect(decoded.project.racks).toEqual({});
    expect(decoded.warnings.map((w) => w.path)).toContain(`racks.${RACK_ID}`);
  });

  it("drops a chain slot whose id is BOTH a rack and a device", () => {
    const project = withRack();
    project.devices[RACK_ID] = {
      id: RACK_ID,
      definitionId: "core.filter",
      version: 1,
      channelId: TRACK_ID,
      enabled: true,
    };
    const decoded = loaded(codec.decode(codec.encode(project)));
    // Unresolvable slot: dropped, and the now-unreferenced rack goes with it.
    expect(decoded.project.channels[TRACK_ID]?.chain).not.toContain(RACK_ID);
    expect(decoded.project.racks[RACK_ID]).toBeUndefined();
  });

  it("re-homes a rack whose channelId disagrees, and rebuilds its chain params", () => {
    const project = withRack({ channelId: "chan-somewhere-else" });
    const stale = project.racks[RACK_ID]?.chains[0]?.gain as string;
    project.paramValues[stale] = -6;

    const decoded = loaded(codec.decode(codec.encode(project)));
    const fixed = decoded.project.racks[RACK_ID];
    expect(fixed?.channelId).toBe(TRACK_ID);
    // The param path encodes the hosting channel, so it must be rebuilt —
    // and the VALUE follows it rather than being silently dropped.
    const rebuilt = rackChainParamId(TRACK_ID, RACK_ID, CHAIN_ID, "gain");
    expect(fixed?.chains[0]?.gain).toBe(rebuilt);
    expect(decoded.project.paramValues[rebuilt]).toBe(-6);
    expect(checkProjectInvariants(decoded.project)).toEqual([]);
  });

  it("keeps a device out of two lists at once", () => {
    const project = withRack();
    const channel = project.channels[TRACK_ID];
    if (channel === undefined) throw new Error("fixture changed");
    const existing = "dev-double";
    project.devices[existing] = {
      id: existing,
      definitionId: "core.filter",
      version: 1,
      channelId: TRACK_ID,
      enabled: true,
    };
    // The same device in the channel chain AND in a rack chain: the channel
    // slot is seen first (chain order), so the rack's copy is the one to go.
    channel.chain = [existing, ...channel.chain];
    const state = project.racks[RACK_ID];
    if (state?.chains[0] !== undefined) state.chains[0].devices = [existing];

    const decoded = loaded(codec.decode(codec.encode(project)));
    expect(decoded.project.racks[RACK_ID]?.chains[0]?.devices).toEqual([]);
    expect(decoded.project.channels[TRACK_ID]?.chain).toContain(existing);
    expect(checkProjectInvariants(decoded.project)).toEqual([]);
  });
});
