// SS11's hit zones — point / segment / flat / empty — against the real
// hit tester, headless (SS15). The value axis is 0..100 linear over a 200 px
// lane, so `h.y(v)` is the only arithmetic a test needs.

import { describe, expect, it } from "vitest";
import { createAutomationHarness, ENUM_DESC } from "./testing/harness";

describe("point zone", () => {
  it("resolves a marker within its slop, and nothing further out", () => {
    const h = createAutomationHarness();
    expect(h.hit(h.x(960), h.y(100))).toMatchObject({ kind: "point", t: 960 });
    expect(h.hit(h.x(960) + 3, h.y(100) - 3)).toMatchObject({ kind: "point", t: 960 });
    expect(h.hit(h.x(960), h.y(100) + 30)).toMatchObject({ kind: "empty" });
  });

  it("wins over the segment it sits on", () => {
    const h = createAutomationHarness();
    expect(h.hit(h.x(0), h.y(0))).toMatchObject({ kind: "point", t: 0 });
  });
});

describe("segment zone", () => {
  it("resolves to the point the segment STARTS at", () => {
    const h = createAutomationHarness();
    // Halfway up the 0..960 segment: value 50.
    expect(h.hit(h.x(480), h.y(50))).toMatchObject({ kind: "segment", startT: 0 });
    // ...and the 960..1920 one, which falls from 100 to 50.
    expect(h.hit(h.x(1440), h.y(75))).toMatchObject({ kind: "segment", startT: 960 });
  });

  it("misses when the pointer is off the curve", () => {
    const h = createAutomationHarness();
    expect(h.hit(h.x(480), h.y(90))).toMatchObject({ kind: "empty" });
  });

  // A lane holds its edges, so the flat run before the first point and after
  // the last are DRAWN but belong to no segment. Resolving them to the first
  // or last point (as the first cut did) bent a segment nowhere near the
  // cursor, or stored a bend on a point with no segment after it at all —
  // they are `flat`: on the curve (click adds a point, SS11), not bendable.
  it("reports the flat lead-in and trail-out as `flat`, not as a segment", () => {
    const h = createAutomationHarness({
      points: [
        [960, 100],
        [1920, 50],
      ],
    });
    expect(h.hit(h.x(480), h.y(100))).toMatchObject({ kind: "flat" }); // lead-in
    expect(h.hit(h.x(2880), h.y(50))).toMatchObject({ kind: "flat" }); // trail-out
    expect(h.hit(h.x(1440), h.y(75))).toMatchObject({ kind: "segment", startT: 960 });
    // Off the drawn line it is still empty space.
    expect(h.hit(h.x(480), h.y(40))).toMatchObject({ kind: "empty" });
  });

  it("a one-point lane is flat everywhere along its held value, and bendable nowhere", () => {
    const h = createAutomationHarness({ points: [[960, 100]] });
    expect(h.hit(h.x(480), h.y(100))).toMatchObject({ kind: "flat" });
    expect(h.hit(h.x(1920), h.y(100))).toMatchObject({ kind: "flat" });
    expect(h.hit(h.x(1920), h.y(40))).toMatchObject({ kind: "empty" });
    expect(h.hit(h.x(960), h.y(100))).toMatchObject({ kind: "point", t: 960 });
  });

  // SS11: "Stepped/enum/toggle params render and edit as steps." The lane is
  // drawn as a staircase, so the pointer must find it as a staircase.
  it("follows the STEP on a discrete lane, not the interpolated line", () => {
    const h = createAutomationHarness({
      desc: ENUM_DESC,
      points: [
        [0, 0],
        [3840, 3],
      ],
    });
    // Held at 0 all the way to the jump...
    expect(h.hit(h.x(1920), h.y(0))).toMatchObject({ kind: "segment", startT: 0 });
    // ...and nothing at the value a swept lane would have had there.
    expect(h.hit(h.x(1920), h.y(1.5))).toMatchObject({ kind: "empty" });
  });
});

describe("empty zone", () => {
  it("is what an empty lane reports everywhere", () => {
    const h = createAutomationHarness({ points: [] });
    expect(h.hit(100, 100)).toMatchObject({ kind: "empty" });
  });

  it("reports nothing at all when no lane is bound (greyed lane, SS7)", () => {
    const h = createAutomationHarness({ desc: null });
    expect(h.hit(h.x(0), h.y(0))).toBeNull();
  });
});
