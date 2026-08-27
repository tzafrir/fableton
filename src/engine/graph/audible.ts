// SS6 "Solo / mute" — solo-in-place as a PURE function.
//
// "A pure function computes the audible set from solo flags across the tree
// (respecting groups and returns fed by soloed tracks), and the engine
// applies it via per-channel mute gains. No routing changes, just gain."
//
// Semantics (the Ableton behaviour users expect):
// - No solos anywhere: a channel is audible unless it is muted, where MUTED
//   means its own `mute` flag or any ancestor's through `output` (see
//   `mutedTransitively` — a muted group really does silence its members).
// - Any solo: audible are (a) the soloed channels themselves — solo
//   overrides the channel's OWN mute, but not a muted ancestor's;
//   (b) their descendants through `output` (soloing a group solos its
//   members), which keep their own mute flags; (c) their ancestors through
//   `output` — the signal path to the master must stay open, but an
//   ancestor's own mute flag is still respected (muting a group beats
//   soloing a member); (d) returns FED by an audible channel's send,
//   computed to a fixpoint so return->return sends chain; (e) the master.
//
// The result feeds `mute` gain values (audible ? 1 : 0) — never the
// document, never history (SS13: meters and audibility are ephemeral).

import type { ChannelId, RackChainId } from "../../types";

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

/**
 * Is this channel silenced by its own mute flag or by a muted ancestor?
 *
 * Mute MUST propagate down the `output` tree. It is tempting to argue that a
 * muted group already silences its members by graph position — their dry
 * signal passes through the group's mute gain — but SENDS do not go that way:
 * a member's send taps its OWN `mute`/`post` node and runs straight into the
 * return's input (see build.ts), bypassing the group entirely. Leaving a
 * member "audible" under a muted group therefore leaks its reverb/delay tail
 * at full level while its dry path is silent. Zeroing the member's own mute
 * gain closes both, because both send taps sit downstream of it.
 */
function mutedTransitively(
  doc: AudibleDocShape,
  channel: AudibleChannelShape,
  memo: Map<ChannelId, boolean>,
): boolean {
  const cached = memo.get(channel.id);
  if (cached !== undefined) return cached;
  memo.set(channel.id, channel.mute); // cycle guard: a malformed doc must terminate
  let muted = channel.mute;
  if (!muted && channel.output !== null) {
    const parent = doc.channels[channel.output];
    if (parent !== undefined) muted = mutedTransitively(doc, parent, memo);
  }
  memo.set(channel.id, muted);
  return muted;
}

/** The set of channels whose mute gain should be OPEN (gain 1). */
export function audibleChannels(doc: AudibleDocShape): Set<ChannelId> {
  const all: AudibleChannelShape[] = [];
  for (const id of doc.channelOrder) {
    const channel = doc.channels[id];
    if (channel !== undefined) all.push(channel);
  }

  const muteMemo = new Map<ChannelId, boolean>();
  /** Own mute or a muted ancestor's. */
  const muted = (c: AudibleChannelShape): boolean => mutedTransitively(doc, c, muteMemo);
  /** A muted ancestor only — what even a solo cannot open. */
  const ancestorMuted = (c: AudibleChannelShape): boolean => {
    if (c.output === null) return false;
    const parent = doc.channels[c.output];
    return parent !== undefined && muted(parent);
  };

  const soloed = all.filter((c) => c.solo);
  const audible = new Set<ChannelId>();

  if (soloed.length === 0) {
    for (const c of all) if (!muted(c)) audible.add(c.id);
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
      // (a): solo overrides the channel's OWN mute — but not a muted
      // ancestor's, or soloing a track inside a muted group would leak its
      // sends past the group (the same hole `mutedTransitively` closes).
      if (!ancestorMuted(c)) audible.add(c.id);
    } else if (inSoloTree.has(c.id) || pathNeeded.has(c.id) || c.role === "master") {
      if (!muted(c)) audible.add(c.id); // (b)/(c)/(e): mute respected
    }
  }

  // (d) returns fed by an audible channel, to a fixpoint (return -> return).
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.role !== "return" || muted(c) || audible.has(c.id)) continue;
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
          if (parent !== undefined && !muted(parent)) audible.add(parent.id);
          cursor = parent;
        }
        grew = true;
      }
    }
  }

  return audible;
}

// --- rack chains -------------------------------------------------------------

/** The shape `audibleChains` needs from a `RackChain` (SS7 racks). */
export interface AudibleChainShape {
  readonly id: RackChainId;
  readonly mute: boolean;
  readonly solo: boolean;
}

/**
 * Chain solo-in-place, the rack-local twin of `audibleChannels`.
 *
 * A rack's chains are siblings with no tree above them and no sends between
 * them, so the whole thing collapses to the two rules that matter: any solo
 * in this rack means only the soloed chains sound (a soloed chain's own mute
 * is overridden, as on a channel); otherwise everything unmuted sounds.
 *
 * Solo is scoped to ONE rack on purpose — soloing a chain of a drum rack's
 * snare should not silence the chains of a rack on the bass. The result
 * feeds `chainMute` gain values, never the document (SS13).
 */
export function audibleChains(chains: readonly AudibleChainShape[]): Set<RackChainId> {
  const audible = new Set<RackChainId>();
  const soloed = chains.some((c) => c.solo);
  for (const chain of chains) {
    if (soloed ? chain.solo : !chain.mute) audible.add(chain.id);
  }
  return audible;
}
