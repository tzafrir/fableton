// SS6 "Metering" — the main-thread bus: which transport it picks, and the
// attach/re-attach/detach bookkeeping around it. The worklet path defers its
// attach behind the module load, which is exactly where the ordering bugs
// live, so the module promise is driven by hand here (SS15: no browser).

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAudioNode, asNode } from "../../devices/harness/testing/fakeAudio";
import { createMeterBus } from "./meters";
import { METER_PROCESSOR_NAME } from "./processorName";
import { DEFAULT_SLOT_COUNT, slabByteLength, writeMeterSlot } from "./slab";

class FakeAnalyser extends FakeAudioNode {
  fftSize = 2048;
  data = new Float32Array(0);
  constructor() {
    super("analyser");
  }
  getFloatTimeDomainData(out: Float32Array): void {
    out.set(this.data.subarray(0, out.length));
  }
}

interface FakeWorkletOptions {
  processorOptions?: { sab?: SharedArrayBuffer; slot?: number };
}

class FakeWorkletNode extends FakeAudioNode {
  static created: FakeWorkletNode[] = [];
  readonly slot: number;
  readonly sab: SharedArrayBuffer | undefined;
  constructor(_ctx: unknown, readonly processorName: string, options: FakeWorkletOptions) {
    super("worklet");
    this.slot = options.processorOptions?.slot ?? -1;
    this.sab = options.processorOptions?.sab;
    FakeWorkletNode.created.push(this);
  }
}

/** A context whose only Web Audio surface is `createAnalyser` — the SS6
 *  fallback path (no COOP/COEP, no worklet). */
function analyserContext(): { ctx: BaseAudioContext; analysers: FakeAnalyser[] } {
  const analysers: FakeAnalyser[] = [];
  const ctx = {
    currentTime: 0,
    createAnalyser(): FakeAnalyser {
      const a = new FakeAnalyser();
      analysers.push(a);
      return a;
    },
  };
  return { ctx: ctx as unknown as BaseAudioContext, analysers };
}

/** A context that supports the worklet path, with the module load held open
 *  so the deferred-attach window can be inspected. */
function workletContext(): {
  ctx: BaseAudioContext;
  loaded(): void;
  failed(): void;
  addModuleCalls: string[];
} {
  const addModuleCalls: string[] = [];
  let settle: { resolve(): void; reject(): void } | undefined;
  const module = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject: () => reject(new Error("addModule failed")) };
  });
  const ctx = {
    currentTime: 0,
    audioWorklet: {
      addModule(url: string): Promise<void> {
        addModuleCalls.push(url);
        return module;
      },
    },
  };
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  FakeWorkletNode.created = [];
  return {
    ctx: ctx as unknown as BaseAudioContext,
    loaded: () => settle?.resolve(),
    failed: () => settle?.reject(),
    addModuleCalls,
  };
}

/** Let every already-queued `.then` on the module promise run. */
async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("meter bus — analyser fallback", () => {
  it("taps the node, measures what the analyser holds, and frees it on detach", () => {
    const { ctx, analysers } = analyserContext();
    const bus = createMeterBus(ctx);
    expect(bus.kind).toBe("analyser");

    const post = new FakeAudioNode("gain");
    bus.attach("t1", asNode(post));
    const analyser = analysers[0];
    expect(analyser).toBeDefined();
    expect(post.connections.map((c) => c.to)).toEqual([analyser]);

    if (analyser !== undefined) analyser.data = new Float32Array(analyser.fftSize).fill(0.5);
    expect(bus.frame("t1")?.peak).toBeCloseTo(0.5, 6);

    bus.detach("t1");
    expect(post.connections).toEqual([]);
    expect(bus.frame("t1")).toBeUndefined();
  });

  it("re-attaching a channel to a different node replaces the tap", () => {
    const { ctx, analysers } = analyserContext();
    const bus = createMeterBus(ctx);
    const first = new FakeAudioNode("gain");
    const second = new FakeAudioNode("gain");
    bus.attach("t1", asNode(first));
    bus.attach("t1", asNode(second));
    expect(first.connections).toEqual([]); // old tap torn down
    expect(second.connections.length).toBe(1);
    expect(analysers.length).toBe(2);

    // The same node twice is a no-op, not a second analyser.
    bus.attach("t1", asNode(second));
    expect(analysers.length).toBe(2);
  });

  it("a context with neither worklet nor analyser degrades to a silent bus", () => {
    const bus = createMeterBus({ currentTime: 0 } as unknown as BaseAudioContext);
    expect(bus.kind).toBe("none");
    const post = new FakeAudioNode("gain");
    bus.attach("t1", asNode(post));
    expect(post.connections).toEqual([]);
    expect(bus.frame("t1")).toBeUndefined();
  });
});

describe("meter bus — worklet path", () => {
  it("defers the attach until the module loads, then reads that strip's slot", async () => {
    const w = workletContext();
    const bus = createMeterBus(w.ctx);
    expect(bus.kind).toBe("worklet");
    expect(w.addModuleCalls.length).toBe(1);

    const post = new FakeAudioNode("gain");
    bus.attach("t1", asNode(post));
    expect(FakeWorkletNode.created).toEqual([]); // still loading
    expect(bus.frame("t1")).toBeUndefined();

    w.loaded();
    await settled();

    const meter = FakeWorkletNode.created[0];
    expect(meter?.processorName).toBe(METER_PROCESSOR_NAME);
    expect(post.connections.map((c) => c.to)).toEqual([meter]);
    // The bus reads the slab slot it handed that node, not slot 0 by luck.
    const sab = meter?.sab;
    expect(sab?.byteLength).toBe(slabByteLength(DEFAULT_SLOT_COUNT));
    if (sab !== undefined && meter !== undefined) {
      writeMeterSlot(new Float32Array(sab), meter.slot, 0.75, 0.5);
    }
    expect(bus.frame("t1")?.peak).toBeCloseTo(0.75, 6);
  });

  it("a re-attach inside the loading window binds the LAST node, not the first", async () => {
    const w = workletContext();
    const bus = createMeterBus(w.ctx);
    const stale = new FakeAudioNode("gain");
    const current = new FakeAudioNode("gain");

    // The reconciler replaced this channel's post node while the worklet
    // module was still loading. Binding the meter to `stale` would leave the
    // strip permanently dark.
    bus.attach("t1", asNode(stale));
    bus.attach("t1", asNode(current));
    w.loaded();
    await settled();

    expect(FakeWorkletNode.created.length).toBe(1);
    expect(stale.connections).toEqual([]);
    expect(current.connections.map((c) => c.to)).toEqual(FakeWorkletNode.created);
  });

  it("a detach inside the loading window cancels the pending attach", async () => {
    const w = workletContext();
    const bus = createMeterBus(w.ctx);
    const post = new FakeAudioNode("gain");
    bus.attach("t1", asNode(post));
    bus.detach("t1");
    w.loaded();
    await settled();
    expect(FakeWorkletNode.created).toEqual([]);
    expect(post.connections).toEqual([]);
  });

  it("re-attaching after the load swaps the tap and recycles the slot", async () => {
    const w = workletContext();
    const bus = createMeterBus(w.ctx);
    const first = new FakeAudioNode("gain");
    const second = new FakeAudioNode("gain");
    bus.attach("t1", asNode(first));
    w.loaded();
    await settled();
    const firstMeter = FakeWorkletNode.created[0];

    bus.attach("t1", asNode(second));
    await settled();
    const secondMeter = FakeWorkletNode.created[1];
    expect(secondMeter).toBeDefined();
    expect(first.connections).toEqual([]);
    expect(second.connections.map((c) => c.to)).toEqual([secondMeter]);
    // Slot freed on detach and handed straight back out — 64 slots is a
    // budget, not a per-attach allowance.
    expect(secondMeter?.slot).toBe(firstMeter?.slot);
  });

  it("a failed module load stays silent instead of constructing an unregistered node", async () => {
    const w = workletContext();
    const bus = createMeterBus(w.ctx);
    const post = new FakeAudioNode("gain");
    bus.attach("t1", asNode(post));
    w.failed();
    await settled();
    expect(bus.kind).toBe("none");
    expect(FakeWorkletNode.created).toEqual([]);
    expect(bus.frame("t1")).toBeUndefined();
  });

  it("dispose drops every tap and ignores later attaches", async () => {
    const w = workletContext();
    const bus = createMeterBus(w.ctx);
    const a = new FakeAudioNode("gain");
    const b = new FakeAudioNode("gain");
    bus.attach("t1", asNode(a));
    bus.attach("t2", asNode(b));
    w.loaded();
    await settled();
    expect(FakeWorkletNode.created.length).toBe(2);

    bus.dispose();
    expect(a.connections).toEqual([]);
    expect(b.connections).toEqual([]);
    expect(bus.frame("t1")).toBeUndefined();

    bus.attach("t1", asNode(a));
    await settled();
    expect(FakeWorkletNode.created.length).toBe(2);
  });
});
