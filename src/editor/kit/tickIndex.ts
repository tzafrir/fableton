// SS9 — "Content culls to the viewport: notes are kept sorted by start tick,
// and the visible window is found by binary search — O(visible) per frame,
// comfortably inside the 2,000-note budget." (SS2)
//
// Two binary searches, not one. Sorting by start alone only bounds the RIGHT
// edge of the window; an item that starts far to the left and stretches into
// view must still be drawn. A prefix-maximum of the end ticks is
// non-decreasing by construction, so the left edge is a binary search too —
// which is what keeps the per-frame cost O(log n + visible) instead of O(n).

import type { Ticks } from "../../types/time";
import type { CreateTickIndex, TickIndex, TickSpan } from "../../types/render";

function isSortedByStart(starts: readonly number[]): boolean {
  for (let i = 1; i < starts.length; i += 1) {
    const prev = starts[i - 1] ?? 0;
    const cur = starts[i] ?? 0;
    if (cur < prev) return false;
  }
  return true;
}

export const createTickIndex: CreateTickIndex = <T>(
  spanOf: (item: T) => TickSpan,
): TickIndex<T> => {
  // Parallel arrays: `spanOf` is called once per item per rebuild and never
  // during a frame, so culling allocates nothing and touches no closures.
  let items: T[] = [];
  let starts: number[] = [];
  let ends: number[] = [];
  /** `maxEnd[i]` = max(ends[0..i]) — non-decreasing, hence binary-searchable. */
  let maxEnd: number[] = [];

  /** First index whose `maxEnd` is strictly greater than `tick`. */
  const lowerBoundByMaxEnd = (tick: Ticks): number => {
    let lo = 0;
    let hi = maxEnd.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((maxEnd[mid] ?? 0) > tick) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  /** First index whose `start` is greater than or equal to `tick`. */
  const lowerBoundByStart = (tick: Ticks): number => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((starts[mid] ?? 0) >= tick) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  const index: TickIndex<T> = {
    rebuild(next: readonly T[]): void {
      const spans = next.map(spanOf);
      let sorted: T[];
      let sortedSpans: TickSpan[];
      if (isSortedByStart(spans.map((s) => s.start))) {
        // The document invariant (clip.notes sorted by (start, pitch)) holds:
        // no sort, no allocation beyond the copy.
        sorted = [...next];
        sortedSpans = spans;
      } else {
        // Defensive: arrangement clips come from an id-keyed record, so the
        // caller's array order is whatever `Object.values` gave it.
        const order = spans.map((_, i) => i);
        order.sort((a, b) => (spans[a]?.start ?? 0) - (spans[b]?.start ?? 0));
        sorted = order.map((i) => next[i] as T);
        sortedSpans = order.map((i) => spans[i] as TickSpan);
      }
      items = sorted;
      starts = sortedSpans.map((s) => s.start);
      ends = sortedSpans.map((s) => s.end);
      maxEnd = new Array<number>(ends.length);
      let running = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < ends.length; i += 1) {
        // A zero-length item reaches `start + 1`: it overlaps its own start
        // tick, so the left-edge search must not skip past it.
        const reach = Math.max(ends[i] ?? 0, (starts[i] ?? 0) + 1);
        running = Math.max(running, reach);
        maxEnd[i] = running;
      }
    },

    inRange(from: Ticks, to: Ticks, out?: T[]): readonly T[] {
      const result = out ?? [];
      if (items.length === 0 || to <= from) return result;
      const hi = lowerBoundByStart(to); // items at/after `to` cannot overlap
      const lo = lowerBoundByMaxEnd(from); // nothing before this reaches `from`
      for (let i = lo; i < hi; i += 1) {
        const start = starts[i] ?? 0;
        const end = ends[i] ?? 0;
        // Half-open [start, end); a zero-length item still counts as
        // overlapping its own start tick (contract, ./types/render.ts).
        const overlaps = end > start ? end > from && start < to : start >= from && start < to;
        if (overlaps) result.push(items[i] as T);
      }
      return result;
    },

    get size() {
      return items.length;
    },
  };

  return index;
};
