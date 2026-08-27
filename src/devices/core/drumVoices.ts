// The drum synthesis primitives, shared by `core.kick` (one engine, played
// chromatically) and `core.drum-machine` (eight engines, one per pad).
//
// Every voice is node-per-hit and self-terminating: it schedules its own
// envelope and `stop()`, and disconnects on `onended`. Nothing here keeps a
// voice list, because a drum hit has no note-off to pair with — a kick rings
// for its decay whether or not the key is still down, which is also why the
// devices below ignore `noteOff` entirely.
//
// The shapes are the classic analogue-drum recipes:
//   kick / tom  — sine with an exponential pitch drop into the body note
//   snare       — tuned triangle body + bandpassed noise, decaying together
//   hat         — highpassed noise, short (closed) or long (open)
//   clap        — three quick noise bursts, then a longer tail
//   rim         — a single very short bandpassed burst plus a high ping
//
// Sample-rate-independent by construction: the noise buffer is generated per
// context, and every time is in seconds, so the offline render (SS12) sounds
// like the live one.

/** MIDI pitch -> Hz (A4 = 440). */
export function midiToHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

/** One second of white noise, made once per context and shared by every hit. */
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseBuffers.get(ctx);
  if (cached !== undefined) return cached;
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Deterministic noise: a plain LCG, so an offline render is bit-identical
  // run to run and a WAV probe can assert on it (SS15).
  let seed = 0x2f6e2b1;
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x3fffffff) - 1;
  }
  noiseBuffers.set(ctx, buffer);
  return buffer;
}

function noiseSource(ctx: BaseAudioContext, at: number, durationS: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  src.start(at);
  src.stop(at + durationS);
  return src;
}

/** Disconnects a hit's nodes once its last source has ended. */
function selfClean(last: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  last.onended = () => {
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        // Already detached (device disposal ran first).
      }
    }
  };
}

export interface HitOptions {
  ctx: BaseAudioContext;
  out: AudioNode;
  at: number;
  /** 0..1, already velocity-scaled by the caller. */
  level: number;
  /** The voice's base pitch in Hz — what "tune" resolves to. */
  hz: number;
  /** Amplitude decay, in seconds. */
  decayS: number;
}

/**
 * Kick / tom: a sine that starts `sweepSemitones` above the body note and
 * falls into it over `pitchDecayS`. The drop IS the beater; without it a kick
 * is just a low sine.
 */
export function kickHit(
  options: HitOptions & { sweepSemitones: number; pitchDecayS: number; clickAmount: number },
): void {
  const { ctx, out, at, level, hz, decayS } = options;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  const top = hz * 2 ** (Math.max(0, options.sweepSemitones) / 12);
  osc.frequency.setValueAtTime(top, at);
  // Exponential, not linear: pitch is perceived logarithmically, and a linear
  // ramp from 4 octaves up spends most of its time inaudibly high.
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(20, hz),
    at + Math.max(0.001, options.pitchDecayS),
  );

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + 0.002);
  env.gain.setTargetAtTime(0, at + 0.002, Math.max(0.005, decayS) / 4);

  osc.connect(env);
  env.connect(out);
  osc.start(at);
  const stopAt = at + Math.max(0.02, decayS * 2);
  osc.stop(stopAt);

  const nodes: AudioNode[] = [osc, env];
  if (options.clickAmount > 0) {
    // The click is a very short highpassed noise burst — the beater hitting
    // the skin, which is what makes a kick audible on a phone speaker.
    const click = noiseSource(ctx, at, 0.01);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1200;
    const clickEnv = ctx.createGain();
    clickEnv.gain.setValueAtTime(level * options.clickAmount, at);
    clickEnv.gain.setTargetAtTime(0, at, 0.002);
    click.connect(hp);
    hp.connect(clickEnv);
    clickEnv.connect(out);
    nodes.push(click, hp, clickEnv);
  }
  selfClean(osc, nodes);
}

/** Snare: a tuned two-oscillator body under a bandpassed noise crack. */
export function snareHit(options: HitOptions & { snappy: number }): void {
  const { ctx, out, at, level, hz, decayS } = options;
  const bodyEnv = ctx.createGain();
  bodyEnv.gain.setValueAtTime(level * (1 - options.snappy * 0.5), at);
  bodyEnv.gain.setTargetAtTime(0, at, Math.max(0.005, decayS) / 6);
  bodyEnv.connect(out);

  const oscs: OscillatorNode[] = [];
  for (const ratio of [1, 1.6]) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = hz * ratio;
    osc.connect(bodyEnv);
    osc.start(at);
    osc.stop(at + Math.max(0.02, decayS * 2));
    oscs.push(osc);
  }

  const noise = noiseSource(ctx, at, Math.max(0.02, decayS * 2));
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 3200;
  bp.Q.value = 0.8;
  const noiseEnv = ctx.createGain();
  noiseEnv.gain.setValueAtTime(level * options.snappy, at);
  noiseEnv.gain.setTargetAtTime(0, at, Math.max(0.005, decayS) / 4);
  noise.connect(bp);
  bp.connect(noiseEnv);
  noiseEnv.connect(out);

  selfClean(noise, [...oscs, bodyEnv, noise, bp, noiseEnv]);
}

/** Hat: highpassed noise. Closed and open differ only by decay. */
export function hatHit(options: HitOptions & { toneHz: number }): void {
  const { ctx, out, at, level, decayS } = options;
  const duration = Math.max(0.02, decayS * 2);
  const noise = noiseSource(ctx, at, duration);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = Math.max(200, options.toneHz);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = Math.max(400, options.toneHz * 1.6);
  bp.Q.value = 0.6;
  const env = ctx.createGain();
  env.gain.setValueAtTime(level, at);
  env.gain.setTargetAtTime(0, at, Math.max(0.003, decayS) / 4);
  noise.connect(hp);
  hp.connect(bp);
  bp.connect(env);
  env.connect(out);
  selfClean(noise, [noise, hp, bp, env]);
}

/** Clap: three fast bursts (the "hands"), then a longer tail. */
export function clapHit(options: HitOptions): void {
  const { ctx, out, at, level, decayS } = options;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1400;
  bp.Q.value = 1.2;
  bp.connect(out);

  const sources: AudioBufferSourceNode[] = [];
  const gains: GainNode[] = [];
  const offsets = [0, 0.011, 0.022];
  for (const offset of offsets) {
    const noise = noiseSource(ctx, at + offset, 0.02);
    const env = ctx.createGain();
    env.gain.setValueAtTime(level * 0.8, at + offset);
    env.gain.setTargetAtTime(0, at + offset, 0.004);
    noise.connect(env);
    env.connect(bp);
    sources.push(noise);
    gains.push(env);
  }
  const tail = noiseSource(ctx, at + 0.03, Math.max(0.05, decayS * 2));
  const tailEnv = ctx.createGain();
  tailEnv.gain.setValueAtTime(level * 0.7, at + 0.03);
  tailEnv.gain.setTargetAtTime(0, at + 0.03, Math.max(0.01, decayS) / 3);
  tail.connect(tailEnv);
  tailEnv.connect(bp);

  selfClean(tail, [...sources, ...gains, tail, tailEnv, bp]);
}

/** Rim: one very short bandpassed burst plus a high ping. */
export function rimHit(options: HitOptions): void {
  const { ctx, out, at, level, hz, decayS } = options;
  const noise = noiseSource(ctx, at, 0.02);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1800;
  bp.Q.value = 3;
  const env = ctx.createGain();
  env.gain.setValueAtTime(level, at);
  env.gain.setTargetAtTime(0, at, Math.max(0.002, decayS) / 6);
  noise.connect(bp);
  bp.connect(env);
  env.connect(out);

  const ping = ctx.createOscillator();
  ping.type = "square";
  ping.frequency.value = Math.max(200, hz * 4);
  const pingEnv = ctx.createGain();
  pingEnv.gain.setValueAtTime(level * 0.35, at);
  pingEnv.gain.setTargetAtTime(0, at, 0.006);
  ping.connect(pingEnv);
  pingEnv.connect(out);
  ping.start(at);
  ping.stop(at + 0.08);

  selfClean(noise, [noise, bp, env, ping, pingEnv]);
}
