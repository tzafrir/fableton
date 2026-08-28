// A headless stand-in for the Web Audio surface the core definitions touch
// (SS15: "no browser needed for any of the load-bearing logic"). Deliberately
// small and separate from the harness's own fake
// (src/devices/harness/testing/fakeAudio.ts), which models the wider surface
// the host and IO need; these tests only exercise a device's own nodes.
//
// Test support only — never imported by non-test code in this package.

import type { DeviceIO, DeviceServices } from "../../../types";

export interface ParamEvent {
  kind: "cancel" | "set" | "linear" | "exponential" | "target";
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
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    this.events.push({ kind: "exponential", value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number): this {
    this.value = value;
    this.events.push({ kind: "target", value, time });
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

/** `OscillatorNode`-alike: records start/stop and can fire `onended` on cue. */
export class FakeOscillatorNode extends FakeAudioNode {
  readonly frequency = new FakeAudioParam(440);
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
  /** Test hook: what the real node does when it reaches its stop time. */
  end(): void {
    this.onended?.();
  }
}

/** `WaveShaperNode`-alike: the curve is the whole point, so it is kept. */
export class FakeWaveShaperNode extends FakeAudioNode {
  curve: Float32Array | null = null;
  oversample = "none";
  /** How many times a curve has been assigned — a drive sweep must not
   *  rebuild the curve (see overdrive.ts), and this is how a test sees it. */
  curveWrites = 0;
  constructor() {
    super("waveshaper");
  }
}

/** `AudioBufferSourceNode`-alike, for the noise-based drum voices. */
export class FakeBufferSourceNode extends FakeAudioNode {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  /** A sampler pitches by playback rate, so it has to be a real param. */
  readonly playbackRate = new FakeAudioParam(1);
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  constructor() {
    super("buffer-source");
  }
  start(when = 0): void {
    this.startedAt = when;
  }
  stop(when = 0): void {
    this.stoppedAt = when;
  }
  end(): void {
    this.onended?.();
  }
}

/** `DelayNode`-alike: the delay TIME is the whole point, so it is recorded. */
export class FakeDelayNode extends FakeAudioNode {
  readonly delayTime = new FakeAudioParam(0);
  constructor(readonly maxDelay = 1) {
    super("delay");
  }
}

export class FakeBiquadNode extends FakeAudioNode {
  readonly frequency = new FakeAudioParam(350);
  readonly Q = new FakeAudioParam(1);
  /** In dB, and only read by the peaking and shelving types — a fake that
   *  omitted it made every shelf and bell device throw on construction. */
  readonly gain = new FakeAudioParam(0);
  /** In CENTS — what a musically-even cutoff modulation drives. */
  readonly detune = new FakeAudioParam(0);
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
  // On the PORT, where the real API puts it: a device listening for its
  // worklet's reports assigns `node.port.onmessage`, and a fake that only
  // offered `node.onmessage` would quietly never deliver one.
  readonly port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
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
  /** Every node the context handed out, in creation order. */
  readonly created: FakeAudioNode[];
  audioWorklet: { addModule(url: string): Promise<void> };
  readonly sampleRate: number;
  createGain(): FakeGainNode;
  createBiquadFilter(): FakeBiquadNode;
  createOscillator(): FakeOscillatorNode;
  createWaveShaper(): FakeWaveShaperNode;
  createDelay(maxDelay?: number): FakeDelayNode;
  createChannelSplitter(count?: number): FakeAudioNode;
  createChannelMerger(count?: number): FakeAudioNode;
  createBufferSource(): FakeBufferSourceNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
}

export function createFakeAudioContext(
  options: { currentTime?: number; sampleRate?: number } = {},
): FakeAudioContext {
  const addedModules: string[] = [];
  const created: FakeAudioNode[] = [];
  const track = <T extends FakeAudioNode>(node: T): T => {
    created.push(node);
    return node;
  };
  return {
    currentTime: options.currentTime ?? 0,
    addedModules,
    created,
    audioWorklet: {
      addModule(url: string): Promise<void> {
        addedModules.push(url);
        return Promise.resolve();
      },
    },
    sampleRate: options.sampleRate ?? 48000,
    createGain: () => track(new FakeGainNode()),
    createBiquadFilter: () => track(new FakeBiquadNode()),
    createOscillator: () => track(new FakeOscillatorNode()),
    createWaveShaper: () => {
      const node = track(new FakeWaveShaperNode());
      // `curve = ...` has to be observable, so the property is an accessor
      // over the recording field rather than a plain slot.
      let curve: Float32Array | null = null;
      Object.defineProperty(node, "curve", {
        get: () => curve,
        set: (next: Float32Array | null) => {
          curve = next;
          node.curveWrites += 1;
        },
      });
      return node;
    },
    createBufferSource: () => track(new FakeBufferSourceNode()),
    createDelay: (maxDelay = 1) => track(new FakeDelayNode(maxDelay)),
    createChannelSplitter: () => track(new FakeAudioNode("splitter")),
    createChannelMerger: () => track(new FakeAudioNode("merger")),
    createBuffer: (channels: number, length: number, sampleRate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (index: number) => data[index] ?? new Float32Array(0),
      } as unknown as AudioBuffer;
    },
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

/** The harness's `DeviceServices`, as a test supplies them: a fixed tempo
 *  whose `bpm` can be moved to exercise a tempo-synced device. */
export function fakeServices(bpm = 120): DeviceServices & { setBpm(next: number): void } {
  let current = bpm;
  const listeners = new Set<() => void>();
  return {
    tempo: {
      secondsPerBeat: () => 60 / current,
      onChange: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    assets: { buffer: () => undefined, onChange: () => () => undefined },
    setBpm(next: number): void {
      current = next;
      for (const cb of [...listeners]) cb();
    },
  };
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
