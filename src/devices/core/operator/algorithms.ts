// The Operator's routing table: which operator modulates which, and which
// ones you actually hear.
//
// This is the whole difference between "an FM synth" and "a two-operator
// demo". Four sine operators can be wired eleven useful ways, and the wiring
// changes the instrument far more than any knob on it does: the same four
// operators are a bell in one algorithm, an electric piano in another and an
// organ in a third. Ableton's Operator draws them as stacks of boxes for
// exactly this reason, and so does our editor.
//
// Kept as PURE DATA in its own module, away from any AudioNode, because
// three separate things need to agree about it: the device (which builds the
// per-voice graph), the editor (which draws the little diagrams), and the
// tests (which check that the graph a given algorithm produces is the one
// the picture promises).
//
// A single target per operator, never a fan-out. That makes every algorithm a
// FOREST — each operator has one parent, carriers have none — which is what
// lets the diagram be drawn as columns of stacked boxes with no crossing
// lines, and what lets the device build a voice with one gain node per
// operator instead of one per edge. It costs a handful of Ableton's shapes
// (the ones where a single modulator feeds two carriers) and buys a model
// that is legible at a glance.

/** How many operators an Operator has. A, B, C, D. */
export const OPERATOR_COUNT = 4;

/** Their names, in the order the params and the editor use. */
export const OPERATOR_NAMES = ["A", "B", "C", "D"] as const;

/** Where an operator's output goes: the index of the operator it modulates,
 *  or `OUT` when it is a carrier and you hear it directly. */
export const OUT = -1;

export interface Algorithm {
  /** How the editor lists it — the routing, written out. */
  readonly label: string;
  /** `targets[i]` is what operator `i` feeds: an operator index, or `OUT`. */
  readonly targets: readonly number[];
}

/**
 * Eleven algorithms, ordered from the deepest stack to pure addition.
 *
 * The order is the point: sweeping the knob from 1 to 11 walks a single axis
 * from "one carrier, three operators of modulation piled on it" (metallic,
 * evolving, the classic DX bell) to "four carriers side by side" (an additive
 * organ, no FM at all). Every step along the way trades a modulator for a
 * carrier, so the timbre gets simpler and thicker rather than jumping around.
 *
 * A is a carrier in all eleven. Something has to be audible, and a synth
 * whose algorithm knob can silence it is a synth with a broken knob.
 */
export const ALGORITHMS: readonly Algorithm[] = [
  { label: "D→C→B→A", targets: [OUT, 0, 1, 2] },
  { label: "D→C→A, B→A", targets: [OUT, 0, 0, 2] },
  { label: "C→B, D→B, B→A", targets: [OUT, 0, 1, 1] },
  { label: "B→A, C→A, D→A", targets: [OUT, 0, 0, 0] },
  { label: "C→B→A · D", targets: [OUT, 0, 1, OUT] },
  { label: "B→A · D→C", targets: [OUT, 0, OUT, 2] },
  { label: "B→A, C→A · D", targets: [OUT, 0, 0, OUT] },
  { label: "B→A · C · D", targets: [OUT, 0, OUT, OUT] },
  { label: "C→B, D→B · A", targets: [OUT, OUT, 1, 1] },
  { label: "D→C · A · B", targets: [OUT, OUT, OUT, 2] },
  { label: "A · B · C · D", targets: [OUT, OUT, OUT, OUT] },
];

export const ALGORITHM_LABELS: readonly string[] = ALGORITHMS.map((a) => a.label);

/** The algorithm at a param value, clamped — a param is a NUMBER (SS4) and
 *  automation can hand it anything inside the descriptor's range. */
export function algorithmAt(index: number): Algorithm {
  const i = Math.min(ALGORITHMS.length - 1, Math.max(0, Math.round(index)));
  return ALGORITHMS[i] ?? ALGORITHMS[0]!;
}

/** Whether operator `op` is heard directly under this algorithm. */
export function isCarrier(algorithm: Algorithm, op: number): boolean {
  return algorithm.targets[op] === OUT;
}

/**
 * Operators in the order they must be BUILT: every modulator before the
 * operator it feeds.
 *
 * A voice wires an operator's gain into its target's `frequency` param, so
 * the target's oscillator has to exist first. With a forest that is just a
 * depth ordering, and with four nodes it is cheap enough to compute by
 * repeated sweeps rather than by keeping a second table in sync with the
 * first — a table that disagreed with `targets` would produce a voice that is
 * silently missing an edge, which is the worst kind of wrong here: quieter,
 * not broken.
 *
 * Returned deepest-first (carriers last), so a builder walking it in reverse
 * always finds its target already made.
 */
export function buildOrder(algorithm: Algorithm): readonly number[] {
  const depth = new Array<number>(OPERATOR_COUNT).fill(0);
  // At most OPERATOR_COUNT-1 hops in a chain of four, so this settles.
  for (let pass = 0; pass < OPERATOR_COUNT; pass++) {
    for (let op = 0; op < OPERATOR_COUNT; op++) {
      const target = algorithm.targets[op] ?? OUT;
      if (target === OUT) continue;
      depth[op] = Math.max(depth[op] ?? 0, (depth[target] ?? 0) + 1);
    }
  }
  const order = [0, 1, 2, 3];
  order.sort((a, b) => (depth[b] ?? 0) - (depth[a] ?? 0) || a - b);
  return order;
}

/**
 * Where the editor draws each operator: `x[op]` is a horizontal slot (which
 * may be fractional — a modulator centres over what it feeds) and `row[op]`
 * is the height, with carriers on row 0 at the bottom.
 *
 * The editor draws boxes, and boxes need coordinates. Putting the layout here
 * rather than in the component keeps the picture and the routing in one file,
 * so an algorithm cannot be added without a shape to draw it in — and so the
 * claim "no two operators land on the same spot" is a unit test rather than
 * something you notice in a screenshot.
 *
 * Laid out the way any tree is: every LEAF gets its own slot, and every
 * parent centres over its children. Stacking by depth alone would have put
 * `C→B` and `D→B` on top of each other, both being one hop above B.
 */
export function diagramLayout(algorithm: Algorithm): {
  readonly x: readonly number[];
  readonly row: readonly number[];
  readonly width: number;
  readonly rows: number;
} {
  const children: number[][] = [[], [], [], []];
  const roots: number[] = [];
  for (let op = 0; op < OPERATOR_COUNT; op++) {
    const target = algorithm.targets[op] ?? OUT;
    if (target === OUT) roots.push(op);
    else children[target]?.push(op);
  }

  const x = new Array<number>(OPERATOR_COUNT).fill(0);
  const row = new Array<number>(OPERATOR_COUNT).fill(0);
  let nextSlot = 0;

  const place = (op: number, depth: number): number => {
    row[op] = depth;
    const kids = children[op] ?? [];
    if (kids.length === 0) {
      x[op] = nextSlot;
      nextSlot += 1;
      return x[op];
    }
    let sum = 0;
    for (const kid of kids) sum += place(kid, depth + 1);
    x[op] = sum / kids.length;
    return x[op];
  };
  for (const root of roots) place(root, 0);

  return { x, row, width: nextSlot, rows: Math.max(...row) + 1 };
}
