// A headless stand-in for the Web Audio nodes the harness touches (SS15:
// "unit tests run in node, no browser"). jsdom ships no Web Audio at all, so
// the tests build their graphs here and assert on recorded connections and
// recorded `AudioParam` automation events.
//
// Test support only — not exported from the package barrel and never imported
// by app code.

import type { DeviceServices } from "../../../types";

export interface ParamEvent {
  kind: "cancel" | "hold" | "set" | "linear" | "target";
  value: number;
  time: number;
}

export interface Connection {
  to: FakeAudioNode | FakeAudioParam;
  output: number;
  input: number;
}

export class FakeAudioParam {
  value: number;
  readonly events: ParamEvent[] = [];
  constructor(
    readonly name: string,
    initial = 0,
  ) {
    this.value = initial;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ kind: "cancel", value: Number.NaN, time });
    return this;
  }
  /** Cancels from `time` onward while holding the value the automation would
   *  have had there — the real browser primitive a future-scheduled ramp is
   *  anchored with. The fake has no curve to sample, so it holds `value`. */
  cancelAndHoldAtTime(time: number): this {
    this.events.push({ kind: "hold", value: this.value, time });
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
  setTargetAtTime(value: number, time: number): this {
    this.value = value;
    this.events.push({ kind: "target", value, time });
    return this;
  }
  /** Value of the last scheduled ramp/set — what the DSP ends up at. */
  get scheduled(): number {
    return this.value;
  }
}

export class FakeAudioNode {
  readonly connections: Connection[] = [];
  disconnectCount = 0;
  channelCount = 2;
  channelCountMode = "max";
  channelInterpretation = "speakers";
  constructor(readonly nodeType: string) {}

  connect(to: FakeAudioNode | FakeAudioParam, output = 0, input = 0): FakeAudioNode | undefined {
    this.connections.push({ to, output, input });
    return to instanceof FakeAudioNode ? to : undefined;
  }
  disconnect(to?: FakeAudioNode | FakeAudioParam): void {
    this.disconnectCount += 1;
    if (to === undefined) {
      this.connections.length = 0;
      return;
    }
    // Targeted disconnect, per the real `AudioNode.disconnect(destination)` —
    // the reconciler removes single edges, never a node's whole fan-out.
    for (let i = this.connections.length - 1; i >= 0; i--) {
      if (this.connections[i]?.to === to) this.connections.splice(i, 1);
    }
  }
}

export class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam("gain", 1);
  constructor() {
    super("gain");
  }
}

export class FakeDelayNode extends FakeAudioNode {
  readonly delayTime = new FakeAudioParam("delayTime", 0);
  constructor() {
    super("delay");
  }
}

export class FakeStereoPannerNode extends FakeAudioNode {
  readonly pan = new FakeAudioParam("pan", 0);
  constructor() {
    super("panner");
  }
}

/** `AudioParamMap`-alike that auto-vivifies a param the first time it is read
 *  — a worklet-backed device asks for its params by name. */
class LazyParamMap extends Map<string, FakeAudioParam> {
  override get(name: string): FakeAudioParam {
    const existing = super.get(name);
    if (existing !== undefined) return existing;
    const created = new FakeAudioParam(name, 0);
    this.set(name, created);
    return created;
  }
}

export class FakeAudioWorkletNode extends FakeAudioNode {
  readonly parameters = new LazyParamMap();
  readonly posted: unknown[] = [];
  readonly port = {
    postMessage: (message: unknown): void => {
      this.posted.push(message);
    },
  };
  constructor(
    readonly processorName: string,
    readonly options?: unknown,
  ) {
    super("audio-worklet");
  }
}

export class FakeConvolverNode extends FakeAudioNode {
  buffer: unknown = null;
  normalize = true;
  constructor() {
    super("convolver");
  }
}

export class FakeWaveShaperNode extends FakeAudioNode {
  curve: Float32Array | null = null;
  oversample = "none";
  constructor() {
    super("waveshaper");
  }
}

export class FakeOscillatorNode extends FakeAudioNode {
  readonly frequency = new FakeAudioParam("frequency", 440);
  readonly detune = new FakeAudioParam("detune", 0);
  type = "sine";
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  constructor() {
    super("oscillator");
  }
  start(when = 0): void {
    this.startedAt = when;
  }
  stop(when = 0): void {
    this.stoppedAt = when;
  }
  /** Test hook: fire what the real node fires when it reaches its stop time. */
  end(): void {
    this.onended?.();
  }
}

/** Just enough `AudioBuffer` for a device that generates an impulse. */
export class FakeAudioBuffer {
  readonly #channels: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.#channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array {
    const data = this.#channels[channel];
    if (data === undefined) throw new Error(`FakeAudioBuffer: no channel ${channel}`);
    return data;
  }
}

export class FakeBiquadNode extends FakeAudioNode {
  readonly frequency = new FakeAudioParam("frequency", 350);
  readonly Q = new FakeAudioParam("Q", 1);
  readonly gain = new FakeAudioParam("gain", 0);
  /** In CENTS — what a musically-even cutoff modulation drives. */
  readonly detune = new FakeAudioParam("detune", 0);
  type = "lowpass";
  constructor() {
    super("biquad");
  }
}

export interface FakeAudioContext {
  currentTime: number;
  readonly sampleRate: number;
  readonly created: FakeAudioNode[];
  readonly addedModules: string[];
  readonly destination: FakeAudioNode;
  audioWorklet: { addModule(url: string): Promise<void> };
  createGain(): FakeGainNode;
  createStereoPanner(): FakeStereoPannerNode;
  createDelay(maxDelay?: number): FakeDelayNode;
  createBiquadFilter(): FakeBiquadNode;
  createChannelSplitter(count?: number): FakeAudioNode;
  createChannelMerger(count?: number): FakeAudioNode;
  createConvolver(): FakeConvolverNode;
  createWaveShaper(): FakeWaveShaperNode;
  createOscillator(): FakeOscillatorNode;
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer;
}

/** A `BaseAudioContext` good enough for the harness, plus test hooks. */
export function createFakeAudioContext(options: { currentTime?: number } = {}): FakeAudioContext {
  const created: FakeAudioNode[] = [];
  const addedModules: string[] = [];
  const track = <T extends FakeAudioNode>(node: T): T => {
    created.push(node);
    return node;
  };
  return {
    currentTime: options.currentTime ?? 0,
    sampleRate: 48000,
    created,
    addedModules,
    destination: new FakeAudioNode("destination"),
    audioWorklet: {
      addModule(url: string): Promise<void> {
        addedModules.push(url);
        return Promise.resolve();
      },
    },
    createGain: () => track(new FakeGainNode()),
    createStereoPanner: () => track(new FakeStereoPannerNode()),
    createDelay: () => track(new FakeDelayNode()),
    createBiquadFilter: () => track(new FakeBiquadNode()),
    createChannelSplitter: () => track(new FakeAudioNode("splitter")),
    createChannelMerger: () => track(new FakeAudioNode("merger")),
    createConvolver: () => track(new FakeConvolverNode()),
    createWaveShaper: () => track(new FakeWaveShaperNode()),
    createOscillator: () => track(new FakeOscillatorNode()),
    createBuffer: (channels: number, length: number, rate: number) =>
      new FakeAudioBuffer(channels, length, rate),
  };
}

/** The same object, typed as the contract expects it. */
/** The harness's `DeviceServices`, as a test supplies them (a fixed tempo). */
export function fakeServices(bpm = 120): DeviceServices {
  return {
    tempo: {
      secondsPerBeat: () => 60 / bpm,
      onChange: () => () => undefined,
    },
  };
}

export function asContext(ctx: FakeAudioContext): BaseAudioContext {
  return ctx as unknown as BaseAudioContext;
}

export function asNode(node: FakeAudioNode): AudioNode {
  return node as unknown as AudioNode;
}

export function asParam(param: FakeAudioParam): AudioParam {
  return param as unknown as AudioParam;
}

export function asGain(node: FakeGainNode): GainNode {
  return node as unknown as GainNode;
}

/** Reads the recorded connections back off a node handed out as an `AudioNode`. */
export function fakeOf(node: AudioNode): FakeAudioNode {
  return node as unknown as FakeAudioNode;
}

/** Node types reachable from a node, for asserting on wiring. */
export function connectedNodeTypes(node: FakeAudioNode): string[] {
  return node.connections.map((c) =>
    c.to instanceof FakeAudioNode ? c.to.nodeType : `param:${c.to.name}`,
  );
}

/** Every `GainNode` this context has handed out, in creation order. */
export function gainsOf(ctx: FakeAudioContext): FakeGainNode[] {
  return ctx.created.filter((n): n is FakeGainNode => n instanceof FakeGainNode);
}

/** Every `DelayNode` this context has handed out, in creation order. */
export function delaysOf(ctx: FakeAudioContext): FakeDelayNode[] {
  return ctx.created.filter((n): n is FakeDelayNode => n instanceof FakeDelayNode);
}

/** Collects a queue of `(cb, ms)` calls instead of running timers. */
export function collectingScheduler(): {
  schedule: (cb: () => void, ms: number) => void;
  calls: Array<{ ms: number }>;
  runAll(): void;
} {
  const pending: Array<{ cb: () => void; ms: number }> = [];
  return {
    schedule: (cb, ms) => {
      pending.push({ cb, ms });
    },
    get calls() {
      return pending.map(({ ms }) => ({ ms }));
    },
    runAll(): void {
      const queue = pending.splice(0, pending.length);
      for (const item of queue) item.cb();
    },
  };
}
