// SS9 — "notes are kept sorted by start tick, and the visible window is found
// by binary search — O(visible) per frame, comfortably inside the 2,000-note
// budget" (SS2).

import { describe, expect, it } from "vitest";
import type { TickSpan } from "../../types/render";
import { createTickIndex } from "./tickIndex";

interface Item {
  id: string;
  start: number;
  dur: number;
}

const spanOf = (n: Item): TickSpan => ({ start: n.start, end: n.start + n.dur });

function items(...spec: readonly [number, number][]): Item[] {
  return spec.map(([start, dur], i) => ({ id: `n${String(i)}`, start, dur }));
}

describe("tickIndex — culling", () => {
  it("reports its size and starts empty", () => {
    const index = createTickIndex(spanOf);
    expect(index.size).toBe(0);
    expect(index.inRange(0, 1000)).toEqual([]);
  });

  it("returns items that OVERLAP the window, in start order", () => {
    const index = createTickIndex(spanOf);
    index.rebuild(items([0, 100], [200, 100], [400, 100], [600, 100]));
    expect(index.inRange(150, 450).map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("includes an item that starts BEFORE the window and reaches into it", () => {
    const index = createTickIndex(spanOf);
    // A long held note starting far to the left must still be drawn.
    index.rebuild(items([0, 10_000], [100, 10], [9000, 10]));
    expect(index.inRange(5000, 6000).map((n) => n.id)).toEqual(["n0"]);
  });

  it("excludes an item that ends exactly at the window start (half-open)", () => {
    const index = createTickIndex(spanOf);
    index.rebuild(items([0, 100], [100, 100]));
    expect(index.inRange(100, 200).map((n) => n.id)).toEqual(["n1"]);
  });

  it("excludes an item that starts exactly at the window end", () => {
    const index = createTickIndex(spanOf);
    index.rebuild(items([0, 50], [100, 50]));
    expect(index.inRange(0, 100).map((n) => n.id)).toEqual(["n0"]);
  });

  it("counts a zero-length item as overlapping its own start tick", () => {
    const index = createTickIndex(spanOf);
    index.rebuild(items([100, 0], [300, 0]));
    expect(index.inRange(100, 200).map((n) => n.id)).toEqual(["n0"]);
    expect(index.inRange(101, 200)).toEqual([]);
    expect(index.inRange(0, 100)).toEqual([]);
  });

  it("returns nothing for an empty or inverted window", () => {
    const index = createTickIndex(spanOf);
    index.rebuild(items([0, 100]));
    expect(index.inRange(50, 50)).toEqual([]);
    expect(index.inRange(80, 20)).toEqual([]);
  });

  it("appends into a caller-provided array so a frame allocates nothing", () => {
    const index = createTickIndex(spanOf);
    index.rebuild(items([0, 100], [200, 100]));
    const out: Item[] = [];
    const first = index.inRange(0, 500, out);
    expect(first).toBe(out);
    expect(out).toHaveLength(2);
    index.inRange(0, 500, out);
    expect(out).toHaveLength(4); // appends, never clears
  });

  it("sorts defensively when the caller's array is not start-sorted", () => {
    const index = createTickIndex(spanOf);
    index.rebuild([
      { id: "late", start: 900, dur: 10 },
      { id: "early", start: 100, dur: 10 },
      { id: "mid", start: 500, dur: 10 },
    ]);
    expect(index.inRange(0, 2000).map((n) => n.id)).toEqual(["early", "mid", "late"]);
  });

  it("rebuild replaces the previous contents", () => {
    const index = createTickIndex(spanOf);
    index.rebuild(items([0, 100]));
    index.rebuild(items([500, 100]));
    expect(index.size).toBe(1);
    expect(index.inRange(0, 200)).toEqual([]);
  });

  it("agrees with a brute-force scan over 2,000 random items (SS2 budget)", () => {
    const index = createTickIndex(spanOf);
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const data: Item[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const start = Math.floor(random() * 200_000);
      const dur = Math.floor(random() * 5000);
      data.push({ id: `n${String(i)}`, start, dur });
    }
    data.sort((a, b) => a.start - b.start);
    index.rebuild(data);
    for (let trial = 0; trial < 40; trial += 1) {
      const from = Math.floor(random() * 200_000);
      const to = from + Math.floor(random() * 20_000) + 1;
      const brute = data
        .filter((n) => (n.dur > 0 ? n.start + n.dur > from && n.start < to : n.start >= from && n.start < to))
        .map((n) => n.id);
      expect(index.inRange(from, to).map((n) => n.id)).toEqual(brute);
    }
  });

  it("calls `spanOf` only on rebuild, never per frame", () => {
    let calls = 0;
    const index = createTickIndex<Item>((n) => {
      calls += 1;
      return spanOf(n);
    });
    index.rebuild(items([0, 100], [200, 100], [400, 100]));
    const afterRebuild = calls;
    for (let i = 0; i < 60; i += 1) index.inRange(0, 1000);
    expect(calls).toBe(afterRebuild);
  });
});
