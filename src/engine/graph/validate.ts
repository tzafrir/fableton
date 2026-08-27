// SS6 "Validation" — "every routing edit (output change, send, sidechain
// edge) runs a DFS cycle check over the combined edge set; cycle-forming
// edits are rejected with an inline hint."
//
// The edge set is CHANNEL-level: `output` edges, send edges, and sidechain
// edges projected onto the channel that hosts the target device. WebAudio
// would technically allow some cycles via DelayNode, but a composition tool
// shouldn't — so this is stricter than the audio graph needs to be, on
// purpose.
//
// Used by the routing commands' `canRun` (src/state/commands/routing.ts):
// the check runs against the WOULD-BE document, so a rejected edit never
// reaches the store at all.

import type { ChannelId, ProjectSnapshot } from "../../types";

export interface RoutingEdgeShape {
  readonly channels: Readonly<
    Record<
      ChannelId,
      {
        readonly id: ChannelId;
        readonly output: ChannelId | null;
        readonly sends: readonly { readonly to: ChannelId }[];
      }
    >
  >;
  readonly devices: ProjectSnapshot["devices"];
  readonly sidechains: readonly {
    readonly from: { readonly channel: ChannelId };
    readonly to: { readonly device: string };
  }[];
}

/** channel -> set of channels it feeds (output + sends + sidechains). */
export function routingAdjacency(doc: RoutingEdgeShape): Map<ChannelId, Set<ChannelId>> {
  const adj = new Map<ChannelId, Set<ChannelId>>();
  const out = (from: ChannelId): Set<ChannelId> => {
    let set = adj.get(from);
    if (set === undefined) {
      set = new Set();
      adj.set(from, set);
    }
    return set;
  };
  for (const channel of Object.values(doc.channels)) {
    if (channel.output !== null) out(channel.id).add(channel.output);
    for (const send of channel.sends) out(channel.id).add(send.to);
  }
  for (const edge of doc.sidechains) {
    const device = doc.devices[edge.to.device];
    if (device !== undefined) out(edge.from.channel).add(device.channelId);
  }
  return adj;
}

/**
 * `null` when the routing is acyclic; otherwise the cycle as a channel-id
 * path (`a -> b -> a`), for the inline hint.
 */
export function findRoutingCycle(doc: RoutingEdgeShape): ChannelId[] | null {
  const adj = routingAdjacency(doc);
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<ChannelId, number>();
  const stack: ChannelId[] = [];

  const visit = (id: ChannelId): ChannelId[] | null => {
    color.set(id, GREY);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of Object.keys(doc.channels)) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found !== null) return found;
    }
  }
  return null;
}

/** The `canRun` message for a cycle, or `null` when the routing is sound. */
export function routingCycleError(doc: RoutingEdgeShape): string | null {
  const cycle = findRoutingCycle(doc);
  if (cycle === null) return null;
  return `routing would loop: ${cycle.join(" -> ")}`;
}
