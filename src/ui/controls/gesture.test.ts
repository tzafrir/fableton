// SS5 conformance table, executed: the headless gesture core against a real
// registry handle (so commit semantics are the app's own).

import { beforeEach, describe, expect, it } from "vitest";
import { createParamRegistry, type AppParamRegistry, type ParamCommit } from "../../params";
import { p } from "../../params/descriptors";
import { withParamId } from "../../params";
import type { ParamHandle } from "../../types";
import { DRAG_FULL_SWEEP_PX, createControlGesture } from "./gesture";

let registry: AppParamRegistry;
let commits: ParamCommit[];

beforeEach(() => {
  registry = createParamRegistry({ now: () => 0 });
  commits = [];
  registry.onCommit((c) => commits.push(c));
});

function linearHandle(min = 0, max = 100, def = 50): ParamHandle {
  return registry.register(
    withParamId(p.continuous("x", "X", { min, max, default: def, unit: "u" }), "chan:t/dev:d/x"),
  );
}

describe("control gesture (SS5)", () => {
  it("150 px of travel sweeps the full range", () => {
    const handle = linearHandle(0, 100, 0);
    const g = createControlGesture(handle);
    g.dragStart(200, false);
    g.dragMove(200 - DRAG_FULL_SWEEP_PX, false);
    expect(handle.live()).toBeCloseTo(100);
    g.dragEnd();
    expect(commits.length).toBe(1);
  });

  it("drag is relative: no jump to the click point", () => {
    const handle = linearHandle(0, 100, 50);
    const g = createControlGesture(handle);
    g.dragStart(500, false); // wherever the pointer went down
    g.dragMove(500, false);
    expect(handle.live()).toBe(50); // unchanged until it MOVES
    g.dragMove(500 - 15, false); // 10% of sweep
    expect(handle.live()).toBeCloseTo(60);
    g.dragEnd();
  });

  it("Shift mid-drag re-anchors: x0.1 sensitivity with no value jump", () => {
    const handle = linearHandle(0, 100, 0);
    const g = createControlGesture(handle);
    g.dragStart(300, false);
    g.dragMove(300 - 75, false); // half sweep -> 50
    expect(handle.live()).toBeCloseTo(50);
    g.dragMove(300 - 75, true); // Shift pressed, SAME position: no jump
    expect(handle.live()).toBeCloseTo(50);
    g.dragMove(300 - 75 - 15, true); // 10% of sweep at x0.1 = 1%
    expect(handle.live()).toBeCloseTo(51);
    g.dragEnd();
    expect(commits.length).toBe(1); // whole drag = one undo entry
  });

  it("Esc mid-drag reverts to the pre-drag value with NO commit", () => {
    const handle = linearHandle(0, 100, 40);
    const g = createControlGesture(handle);
    g.dragStart(100, false);
    g.dragMove(40, false);
    expect(handle.live()).not.toBe(40);
    g.dragCancel();
    expect(handle.live()).toBe(40);
    expect(commits.length).toBe(0);
    expect(g.dragging).toBe(false);
  });

  it("wheel steps 1% of sweep (0.1% with Shift), one commit each", () => {
    const handle = linearHandle(0, 100, 50);
    const g = createControlGesture(handle);
    g.wheel(1, false);
    expect(handle.live()).toBeCloseTo(51);
    g.wheel(-1, true);
    expect(handle.live()).toBeCloseTo(50.9);
    expect(commits.length).toBe(2);
  });

  it("keyboard: arrows 1%, Shift 0.1%, PgUp 10%", () => {
    const handle = linearHandle(0, 100, 50);
    const g = createControlGesture(handle);
    g.keyStep(1);
    expect(handle.live()).toBeCloseTo(51);
    g.keyStep(-1, { fine: true });
    expect(handle.live()).toBeCloseTo(50.9);
    g.keyStep(1, { page: true });
    expect(handle.live()).toBeCloseTo(60.9);
  });

  it("reset returns to defaultValue and commits once", () => {
    const handle = linearHandle(0, 100, 25);
    const g = createControlGesture(handle);
    g.wheel(5, false);
    commits.length = 0;
    g.reset();
    expect(handle.live()).toBe(25);
    expect(commits.length).toBe(1);
  });

  it("text entry parses through fromText and clamps to the range", () => {
    const handle = linearHandle(0, 100, 50);
    const g = createControlGesture(handle);
    expect(g.setFromText("72")).toBe(true);
    expect(handle.live()).toBe(72);
    expect(g.setFromText("bananas")).toBe(false);
    expect(handle.live()).toBe(72);
    expect(g.setFromText("400")).toBe(true);
    expect(handle.live()).toBe(100); // clamped
  });

  it("log taper: the drag moves through the taper, not linearly", () => {
    const handle = registry.register(
      withParamId(p.hz("cutoff", "Cutoff", { min: 20, max: 20000, default: 20 }), "chan:t/dev:d/cutoff"),
    );
    const g = createControlGesture(handle);
    g.dragStart(0, false);
    g.dragMove(-DRAG_FULL_SWEEP_PX / 2, false); // half sweep
    // Half of a log sweep from 20..20k lands at sqrt(20 * 20000) ~ 632 Hz.
    expect(handle.live()).toBeGreaterThan(500);
    expect(handle.live()).toBeLessThan(800);
    g.dragEnd();
  });

  it("enum params step whole increments per wheel notch", () => {
    const handle = registry.register(
      withParamId(p.enum("type", "Type", { labels: ["a", "b", "c", "d"] }), "chan:t/dev:d/type"),
    );
    const g = createControlGesture(handle);
    expect(handle.live()).toBe(0);
    g.wheel(1, false);
    expect(handle.live()).toBe(1);
    g.wheel(1, false);
    g.wheel(1, false);
    g.wheel(1, false);
    expect(handle.live()).toBe(3); // clamped at the last label
    g.wheel(-1, false);
    expect(handle.live()).toBe(2);
  });

  it("stepped params honour their step for keys and wheel", () => {
    const handle = registry.register(
      withParamId(p.stepped("semi", "Semi", { min: -12, max: 12, default: 0, step: 1 }), "chan:t/dev:d/semi"),
    );
    const g = createControlGesture(handle);
    g.keyStep(1);
    expect(handle.live()).toBe(1);
    g.wheel(-1, false);
    g.wheel(-1, false);
    expect(handle.live()).toBe(-1);
  });
});
