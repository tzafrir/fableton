// SS6 — `diff(live, desired)` over two `GraphDescription`s. Pure: the
// reconciler keeps the description it last applied and diffs it against the
// next one, so "reacting to 'effect moved from chain[2] to chain[0]'" is a
// targeted patch, never a rebuild (SS13).
//
// Ordering contract (the reconciler applies fields in declaration order):
//   1. createUtils     — new nodes exist before anything connects to them
//   2. mountDevices    — same, for device ports (async: worklet `prepare`)
//   3. disconnect      — old edges drop while boundary gains are dipped
//   4. connect         — new edges attach
//   5. unmountDevices  — ramped by the harness, disposal deferred (SS7)
//   6. disposeUtils    — after nothing references them

import type { GraphDescription, GraphPatch } from "../../types/graph";

export function diffGraph(live: GraphDescription, desired: GraphDescription): GraphPatch {
  const patch: GraphPatch = {
    createUtils: [],
    mountDevices: [],
    disconnect: [],
    connect: [],
    unmountDevices: [],
    disposeUtils: [],
  };

  for (const [ref, spec] of desired.utils) {
    if (!live.utils.has(ref)) patch.createUtils.push(spec);
  }
  for (const [id, spec] of desired.mounts) {
    const prior = live.mounts.get(id);
    // Same instance id but a different definition or channel is a REPLACE:
    // unmount + remount (params re-register under the new channel path).
    if (prior === undefined) {
      patch.mountDevices.push(spec);
    } else if (prior.definitionId !== spec.definitionId || prior.channelId !== spec.channelId) {
      patch.unmountDevices.push(id);
      patch.mountDevices.push(spec);
    }
  }

  for (const [id, edge] of live.edges) {
    if (!desired.edges.has(id)) patch.disconnect.push(edge);
  }
  for (const [id, edge] of desired.edges) {
    if (!live.edges.has(id)) patch.connect.push(edge);
  }

  for (const id of live.mounts.keys()) {
    if (!desired.mounts.has(id)) patch.unmountDevices.push(id);
  }
  for (const ref of live.utils.keys()) {
    if (!desired.utils.has(ref)) patch.disposeUtils.push(ref);
  }

  return patch;
}
