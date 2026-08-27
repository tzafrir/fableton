// A headless stand-in for the Web Audio surface the core definitions touch
// (SS15: "no browser needed for any of the load-bearing logic"). Deliberately
// small and separate from the harness's own fake
// (src/devices/harness/testing/fakeAudio.ts), which models the wider surface
// the host and IO need; these tests only exercise a device's own nodes.
//
// Test support only — never imported by non-test code in this package.

import type { DeviceIO } from "../../../types";

export interface ParamEvent {
  kind: "cancel" | "set" | "linear";
  value: number;
  time: number;
}

export class FakeAudioParam {
  value: number;
  readonly events: ParamEvent[] = [];
  constructor(initial = 0) {
    this.value = initial;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ kind: "cancel", value: Number.NaN, time });
    return this;
  }
  setValueAtTime(value: number, time: number): this {
    this.value = value;
    this.events.push({ kind: "set", value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    this.events.push({ kind: "linear", value, time });
    return this;
  }
}

export class FakeAudioNode {
  readonly connectedTo: Array<FakeAudioNode | FakeAudioParam> = [];
  disconnectCount = 0;
  constructor(readonly nodeType: string) {}
  connect(to: FakeAudioNode | FakeAudioParam): FakeAudioNode | undefined {
    this.connectedTo.push(to);
    return to instanceof FakeAudioNode ? to : undefined;
  }
  disconnect(): void {
    this.disconnectCount += 1;
    this.connectedTo.length = 0;
  }
}

export class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam(1);
  constructor() {
    super("gain");
  }
}

export class FakeBiquadNode extends FakeAudioNode {
  readonly frequency = new FakeAudioParam(350);
  readonly Q = new FakeAudioParam(1);
  type = "lowpass";
  constructor() {
    super("biquad");
  }
}

/** `AudioParamMap`-alike that auto-vivifies a param the first time it's read. */
class LazyParamMap extends Map<string, FakeAudioParam> {
  override get(name: string): FakeAudioParam {
    const existing = super.get(name);
    if (existing !== undefined) return existing;
    const created = new FakeAudioParam(0);
    this.set(name, created);
    return created;
  }
}

export class FakeAudioWorkletNode extends FakeAudioNode {
  readonly parameters = new LazyParamMap();
  readonly posted: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly port = {
    postMessage: (message: unknown): void => {
      // Real `postMessage` structured-clones its argument, which is what lets
      // the sender reuse one payload object per message type (SS12 "zero
      // allocation in per-tick paths"). Cloning here keeps the recording
      // faithful instead of storing N aliases of one mutable object.
      this.posted.push(structuredClone(message));
    },
  };
  constructor(
    readonly processorName: string,
    readonly options?: unknown,
  ) {
    super("audio-worklet");
  }
}

export interface FakeAudioContext {
  currentTime: number;
  readonly addedModules: string[];
  audioWorklet: { addModule(url: string): Promise<void> };
  createGain(): FakeGainNode;
  createBiquadFilter(): FakeBiquadNode;
}

export function createFakeAudioContext(options: { currentTime?: number } = {}): FakeAudioContext {
  const addedModules: string[] = [];
  return {
    currentTime: options.currentTime ?? 0,
    addedModules,
    audioWorklet: {
      addModule(url: string): Promise<void> {
        addedModules.push(url);
        return Promise.resolve();
      },
    },
    createGain: () => new FakeGainNode(),
    createBiquadFilter: () => new FakeBiquadNode(),
  };
}

export function asContext(ctx: FakeAudioContext): BaseAudioContext {
  return ctx as unknown as BaseAudioContext;
}

export function asNode(node: FakeAudioNode): AudioNode {
  return node as unknown as AudioNode;
}

export function asGain(node: FakeGainNode): GainNode {
  return node as unknown as GainNode;
}

export function asParam(param: FakeAudioParam): AudioParam {
  return param as unknown as AudioParam;
}

/** Reads a node handed out through a typed `AudioNode`/`AudioParam` slot back. */
export function fakeOf<T>(value: T): FakeAudioNode {
  return value as unknown as FakeAudioNode;
}

/** A minimal `DeviceIO` — two harness-owned port gains, wired up like the real one. */
export function buildDeviceIO(ctx: FakeAudioContext): { io: DeviceIO; input: FakeGainNode; output: FakeGainNode } {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const io: DeviceIO = {
    in: asNode(input),
    out: asNode(output),
    inputs: Object.freeze({ in: asNode(input) }),
    outputs: Object.freeze({ out: asNode(output) }),
  };
  return { io, input, output };
}

/** Collects `(cb, ms)` calls instead of running real timers. */
export function collectingScheduler(): {
  schedule: (cb: () => void, ms: number) => void;
  calls: number[];
  runAll(): void;
} {
  const pending: Array<{ cb: () => void; ms: number }> = [];
  return {
    schedule: (cb, ms) => {
      pending.push({ cb, ms });
    },
    get calls() {
      return pending.map((p) => p.ms);
    },
    runAll(): void {
      const queue = pending.splice(0, pending.length);
      for (const item of queue) item.cb();
    },
  };
}
