// The arpeggio ORDER rule, shared by the two things that arpeggiate.
//
// There are two arpeggiators in this app and they are deliberately different
// tools: `src/state/arpeggio.ts` rewrites the notes in a clip (one command,
// one undo entry, editable afterwards), and `src/devices/core/arpeggiator.ts`
// is a live note effect that turns held chords into a stream on the way to
// the instrument. What they must NOT differ in is the order the notes come
// out in — running the transform and running the device over the same chord
// should sound the same — so that rule lives here, in a leaf module neither
// layer owns.

import type { ArpMode } from "../types";

export type { ArpMode };

/** Every mode, in the order both pickers list them. */
export const ARP_MODES: readonly ArpMode[] = [
  "up",
  "down",
  "upDown",
  "downUp",
  "asPlayed",
  "random",
];

/**
 * The order pitches are visited in, as a list of indices into a low-to-high
 * pitch list of length `n`.
 *
 * `upDown`/`downUp` do NOT repeat the turning notes — an up-down over three
 * pitches is 1 2 3 2, not 1 2 3 3 2 1 — because the repeat is what makes a
 * bounced arp limp on every cycle.
 *
 * `random` returns the plain ascending list: the CALLER picks an index at
 * random, which keeps the randomness (and its seeding) where the caller can
 * control it — the live device wants a deterministic stream so an offline
 * render is reproducible, the transform wants an injectable one so a test is.
 */
export function arpOrder(n: number, mode: ArpMode): number[] {
  if (n <= 0) return [];
  const up = Array.from({ length: n }, (_, i) => i);
  switch (mode) {
    case "up":
    case "asPlayed":
    case "random":
      return up;
    case "down":
      return [...up].reverse();
    case "upDown":
      return n <= 2 ? up : [...up, ...up.slice(1, -1).reverse()];
    case "downUp": {
      const down = [...up].reverse();
      return n <= 2 ? down : [...down, ...down.slice(1, -1).reverse()];
    }
  }
}
