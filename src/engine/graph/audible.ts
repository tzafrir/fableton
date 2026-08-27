// SS6 "Solo / mute" — solo-in-place as a PURE function.
//
// "A pure function computes the audible set from solo flags across the tree
// (respecting groups and returns fed by soloed tracks), and the engine
// applies it via per-channel mute gains. No routing changes, just gain."
//
// Semantics (the Ableton behaviour users expect):
// - No solos anywhere: a channel is audible unless its own `mute` flag is
//   set. A muted GROUP silences its members through graph position alone
//   (their signal passes through the group's mute gain), so mute never
//   propagates here.
// - Any solo: audible are (a) the soloed channels themselves — solo
//   overrides the channel's OWN mute; (b) their descendants through `output`
//   (soloing a group solos its members), which keep their own mute flags;
//   (c) their ancestors through `output` — the signal path to the master
//   must stay open, but an ancestor's own mute flag is still respected
//   (muting a group beats soloing a member); (d) returns FED by an audible
//   channel's send, computed to a fixpoint so return->return sends chain;
//   (e) the master.
//
// The result feeds `mute` gain values (audible ? 1 : 0) — never the
// document, never history (SS13: meters and audibility are ephemeral).

import type { ChannelId } from "../../types";

export interface AudibleChannelShape {
  readonly id: ChannelId;
  readonly role: "track" | "group" | "return" | "master";
  readonly mute: boolean;
  readonly solo: boolean;
  readonly sends: readonly { readonly to: ChannelId }[];
  readonly output: ChannelId | null;
}

export interface AudibleDocShape {
  readonly channelOrder: readonly ChannelId[];
  readonly channels: Readonly<Record<ChannelId, AudibleChannelShape>>;
}

/** The set of channels whose mute gain should be OPEN (gain 1). */
export function audibleChannels(doc: AudibleDocShape): Set<ChannelId> {
  const all: AudibleChannelShape[] = [];
  for (const id of doc.channelOrder) {
    const channel = doc.channels[id];
    if (channel !== undefined) all.push(channel);
  }

  const soloed = all.filter((c) => c.solo);
  const audible = new Set<ChannelId>();

  if (soloed.length === 0) {
    for (const c of all) if (!c.mute) audible.add(c.id);
    return audible;
  }

  // (a) soloed channels — their own mute is overridden by the solo.
  const inSoloTree = new Set<ChannelId>();
  for (const c of soloed) inSoloTree.add(c.id);

  // (b) descendants of soloed channels (members of a soloed group), found by
  // walking each channel's output chain upward — O(n * depth), n is small.
  for (const c of all) {
    let cursor: AudibleChannelShape | undefined = c;
    const seen = new Set<ChannelId>();
    while (cursor !== undefined && cursor.output !== null && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (inSoloTree.has(cursor.output)) {
        inSoloTree.add(c.id);
        break;
      }
      cursor = doc.channels[cursor.output];
    }
  }

  // (c) ancestors of soloed channels — the path to the master.
  const pathNeeded = new Set<ChannelId>();
  for (const c of soloed) {
    let cursor: AudibleChannelShape | undefined = c;
    const seen = new Set<ChannelId>();
    while (cursor !== undefined && cursor.output !== null && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      pathNeeded.add(cursor.output);
      cursor = doc.channels[cursor.output];
    }
  }

  for (const c of all) {
    if (c.solo) {
      audible.add(c.id); // (a): solo overrides own mute
    } else if (inSoloTree.has(c.id) || pathNeeded.has(c.id) || c.role === "master") {
      if (!c.mute) audible.add(c.id); // (b)/(c)/(e): own mute respected
    }
  }

  // (d) returns fed by an audible channel, to a fixpoint (return -> return).
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.role !== "return" || c.mute || audible.has(c.id)) continue;
      const fed = all.some(
        (sender) => audible.has(sender.id) && sender.sends.some((s) => s.to === c.id),
      );
      if (fed) {
        audible.add(c.id);
        // The return's own path to the master must open too.
        let cursor: AudibleChannelShape | undefined = c;
        const seen = new Set<ChannelId>();
        while (cursor !== undefined && cursor.output !== null && !seen.has(cursor.id)) {
          seen.add(cursor.id);
          const parent: AudibleChannelShape | undefined = doc.channels[cursor.output];
          if (parent !== undefined && !parent.mute) audible.add(parent.id);
          cursor = parent;
        }
        grew = true;
      }
    }
  }

  return audible;
}
