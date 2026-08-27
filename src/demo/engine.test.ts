// Integration test for the M0 spine's wiring (SS18-M0): the demo engine
// mounts the two registered core devices, chains synth -> filter ->
// destination, and the transport turns the hard-coded clip into timestamped
// note events on the instrument.
//
// jsdom has no Web Audio at all, so this runs against `device-harness`'s
// shared `FakeAudioContext` plus a stubbed `AudioWorkletNode` (the same
// `vi.stubGlobal` shape src/devices/core/polySynth.test.ts uses). The real
// non-silence proof, on a real `OfflineAudioContext`, is
// e2e/audio/offline-render.spec.ts (SS15).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeAudioNode,
  FakeAudioParam,
  FakeBiquadNode,
  type FakeAudioContext,
  createFakeAudioContext,
} from "../devices/harness/testing/fakeAudio";
import { POLY_SYNTH_PROCESSOR_NAME } from "../devices/core/polySynth/processorName";
import { createManualClock } from "../engine/transport";
import { deviceParamId } from "../params";
import {
  createDemoEngine,
  demoClipDurationSeconds,
  DEMO_CUTOFF_PARAM_ID,
  DEMO_SYNTH_GAIN_DB,
} from "./engine";
import { DEMO_CLIP, DEMO_TRACK_ID } from "./clip";

interface NoteMessage {
  type: string;
  pitch?: number;
  when: number;
}

/** `AudioWorkletNode.parameters`, minus the browser: a k-rate param appears
 *  the first time the device asks for it. */
class VivifyingParamMap extends Map<string, FakeAudioParam> {
  override get(name: string): FakeAudioParam {
    let param = super.get(name);
    if (param === undefined) {
      param = new FakeAudioParam(name, 0);
      this.set(name, param);
    }
    return param;
  }
}

/** Minimal `AudioWorkletNode` stand-in: every `port.postMessage` (the synth's
 *  note path) is recorded so the transport's output can be asserted on. */
class StubAudioWorkletNode extends FakeAudioNode {
  readonly parameters = new VivifyingParamMap();
  readonly posted: NoteMessage[] = [];
  readonly port = {
    postMessage: (message: unknown): void => {
      // Structured clone, as the real port does — the synth reuses one
      // payload object per message type (SS12 zero-allocation guardrail).
      this.posted.push(structuredClone(message) as NoteMessage);
    },
  };
  constructor(
    _ctx: unknown,
    readonly processorName: string,
  ) {
    super("audio-worklet");
    workletNodes.push(this);
  }
}

let workletNodes: StubAudioWorkletNode[] = [];

beforeEach(() => {
  workletNodes = [];
  vi.stubGlobal("AudioWorkletNode", StubAudioWorkletNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(currentTime = 0): { ctx: BaseAudioContext; base: FakeAudioContext } {
  const base = createFakeAudioContext({ currentTime });
  return { ctx: base as unknown as BaseAudioContext, base };
}

/** Whether any node this context created connects (directly) to `target`. */
function anyNodeConnectsTo(base: FakeAudioContext, target: object): boolean {
  return base.created.some((n) => n.connections.some((c) => c.to === target));
}

/**
 * Every simple audio path from `from` to `target`, following recorded
 * node-to-node connections (a connection into an `AudioParam` is modulation,
 * not an audio path, so it is not followed).
 *
 * This is what pins the ASSEMBLY step — the one piece of wiring no per-device
 * test can cover, since `filter.test.ts` / `polySynth.test.ts` only see inside
 * one device. `synth.output.connect(destination)` with the filter left mounted
 * but dangling passes every level-based assertion in the repo; it does not
 * pass "every path from the instrument to the destination runs through the
 * filter".
 */
function audioPaths(from: FakeAudioNode, target: FakeAudioNode): FakeAudioNode[][] {
  const found: FakeAudioNode[][] = [];
  const walk = (node: FakeAudioNode, trail: readonly FakeAudioNode[]): void => {
    if (trail.includes(node)) return; // cycle guard
    const next = [...trail, node];
    if (node === target) {
      found.push(next);
      return;
    }
    for (const c of node.connections) {
      if (c.to instanceof FakeAudioNode) walk(c.to, next);
    }
  };
  walk(from, []);
  return found;
}

function synthNode(): StubAudioWorkletNode {
  const node = workletNodes[0];
  if (node === undefined) throw new Error("no AudioWorkletNode was constructed");
  return node;
}

describe("createDemoEngine (SS18-M0 hard-coded chain)", () => {
  it("mounts the registered core devices and wires synth -> filter -> destination", async () => {
    const { ctx, base } = setup();
    const engine = await createDemoEngine(ctx, base.destination as unknown as AudioNode, {
      clock: createManualClock(),
    });

    // core.poly-synth's worklet module was loaded through the SS7 `prepare`
    // step, and its node built exactly once.
    expect(base.addedModules).toHaveLength(1);
    expect(workletNodes).toHaveLength(1);
    expect(synthNode().processorName).toBe(POLY_SYNTH_PROCESSOR_NAME);

    const biquads = base.created.filter((n): n is FakeBiquadNode => n instanceof FakeBiquadNode);
    expect(biquads).toHaveLength(1); // exactly one core.filter mounted

    expect(anyNodeConnectsTo(base, base.destination)).toBe(true);

    // ...and the chain is the SS18-M0 one, in order: the instrument reaches
    // the destination, and it reaches it ONLY through `core.filter`. Nothing
    // else in either test suite would notice the filter being mounted but left
    // out of the audio path.
    const paths = audioPaths(synthNode(), base.destination);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path).toContain(biquads[0]);
    }
    // The filter's own output is what terminates the chain.
    expect(audioPaths(biquads[0]!, base.destination).length).toBeGreaterThan(0);

    engine.dispose();
  });

  it("binds every device param the definitions declare (SS7 connectParam)", async () => {
    const { ctx, base } = setup();
    const engine = await createDemoEngine(ctx, base.destination as unknown as AudioNode, {
      clock: createManualClock(),
    });

    // The synth's seven k-rate params were fetched off the worklet node and
    // bound to handles (SS4 fast path A).
    expect([...synthNode().parameters.keys()].sort()).toEqual(
      ["attack", "cutoff", "decay", "gain", "release", "shape", "sustain"],
    );

    engine.dispose();
  });

  it("leaves the instrument headroom so the audible proof does not clip", async () => {
    // Every note of the phrase overlaps the previous note's release, so two
    // voices sum; a 0 dB instrument straight into the destination peaks past
    // full scale and the destination hard-clips it on real hardware. The
    // headroom is written through the sanctioned path, so it is a committed
    // (document) value, not a hidden node poke.
    const { ctx, base } = setup();
    const engine = await createDemoEngine(ctx, base.destination as unknown as AudioNode, {
      clock: createManualClock(),
    });

    const gain = engine.params.require(
      deviceParamId(DEMO_TRACK_ID, "demo-synth", "gain"),
    );
    expect(gain.base()).toBe(DEMO_SYNTH_GAIN_DB);
    expect(gain.live()).toBe(DEMO_SYNTH_GAIN_DB);
    expect(DEMO_SYNTH_GAIN_DB).toBeLessThan(0);
    // ...and it reached the worklet's own k-rate AudioParam (fast path A).
    expect(synthNode().parameters.get("gain").scheduled).toBe(DEMO_SYNTH_GAIN_DB);

    engine.dispose();
  });

  it("drives the live filter through the SS4 handle, and commits once (SS3)", async () => {
    // The UI half of the sanctioned bridge: a control reaches the DSP only
    // through `setLive` (fast path A, no document churn) and turns the gesture
    // into exactly one command at `commit()`.
    const { ctx, base } = setup();
    const engine = await createDemoEngine(ctx, base.destination as unknown as AudioNode, {
      clock: createManualClock(),
    });

    const biquad = base.created.find((n): n is FakeBiquadNode => n instanceof FakeBiquadNode);
    expect(biquad).toBeDefined();
    const commits: Array<{ value: number; previous: number }> = [];
    engine.onParamCommit((commit) => commits.push({ value: commit.value, previous: commit.previous }));

    const cutoff = engine.params.require(DEMO_CUTOFF_PARAM_ID);
    const before = cutoff.base();
    cutoff.setLive(4000, "user");
    cutoff.setLive(5000, "user");
    expect(biquad!.frequency.scheduled).toBe(5000); // the drag reached the node
    expect(commits).toEqual([]); // ...without touching the document

    cutoff.commit();
    expect(commits).toEqual([{ value: 5000, previous: before }]);

    engine.dispose();
  });

  it("schedules the whole hard-coded clip in one look-ahead window and plays it", async () => {
    const { ctx, base } = setup();
    const duration = demoClipDurationSeconds();
    const engine = await createDemoEngine(ctx, base.destination as unknown as AudioNode, {
      clock: createManualClock(),
      lookAheadSeconds: duration, // covers the entire clip in the first tick
    });

    expect(engine.transport.state).toBe("stopped");
    engine.transport.play(0);
    expect(engine.transport.state).toBe("playing");

    const posted = synthNode().posted;
    const noteOns = posted.filter((m) => m.type === "noteOn");
    const noteOffs = posted.filter((m) => m.type === "noteOff");
    expect(noteOns).toHaveLength(DEMO_CLIP.notes.length);
    expect(noteOffs).toHaveLength(DEMO_CLIP.notes.length);

    // Every event carries an exact audio-clock timestamp (SS12) and the
    // note-ons fire in the clip's own tick order.
    expect(noteOns.every((m) => Number.isFinite(m.when) && m.when >= 0)).toBe(true);
    const startTimes = noteOns.map((m) => m.when);
    expect([...startTimes]).toEqual([...startTimes].sort((a, b) => a - b));
    expect(noteOns.map((m) => m.pitch)).toEqual(DEMO_CLIP.notes.map((n) => n.pitch));

    engine.transport.stop();
    expect(engine.transport.state).toBe("stopped");

    engine.dispose();
  });

  it("dispose() stops playback and releases the transport", async () => {
    const { ctx, base } = setup();
    const engine = await createDemoEngine(ctx, base.destination as unknown as AudioNode, {
      clock: createManualClock(),
      lookAheadSeconds: demoClipDurationSeconds(),
    });

    engine.transport.play(0);
    expect(engine.transport.state).toBe("playing");

    engine.dispose();
    expect(engine.transport.state).toBe("stopped");
  });
});
