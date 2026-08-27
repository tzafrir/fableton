import { describe, expect, it } from "vitest";
import { AdsrEnvelope } from "./envelope";

// sampleRate = 1000 makes "N samples" == "N ms", which keeps the arithmetic
// in these tests exact instead of approximate.
const SR = 1000;

describe("AdsrEnvelope", () => {
  it("starts idle at level 0", () => {
    const env = new AdsrEnvelope(SR);
    expect(env.currentStage).toBe("idle");
    expect(env.currentLevel).toBe(0);
    expect(env.isIdle).toBe(true);
    expect(env.next()).toBe(0);
  });

  it("attacks linearly to 1 over attackSeconds, then moves to decay", () => {
    const env = new AdsrEnvelope(SR);
    env.noteOn({ attackSeconds: 0.01, decaySeconds: 0.01, sustainLevel: 0.5, releaseSeconds: 0.01 });
    // 10 ms attack at 1000 Hz = 10 samples.
    let last = 0;
    for (let i = 0; i < 10; i++) {
      last = env.next();
      expect(last).toBeGreaterThanOrEqual(0);
    }
    expect(last).toBeCloseTo(1, 5);
    expect(env.currentStage).toBe("decay");
  });

  it("decays from 1 to the sustain level, then holds", () => {
    const env = new AdsrEnvelope(SR);
    env.noteOn({ attackSeconds: 0.001, decaySeconds: 0.01, sustainLevel: 0.4, releaseSeconds: 0.01 });
    for (let i = 0; i < 1; i++) env.next(); // clear the (tiny) attack
    for (let i = 0; i < 10; i++) env.next(); // 10 ms decay
    expect(env.currentStage).toBe("sustain");
    expect(env.currentLevel).toBeCloseTo(0.4, 5);
    // Holds indefinitely.
    for (let i = 0; i < 50; i++) expect(env.next()).toBeCloseTo(0.4, 5);
  });

  it("holds a SILENT sustain when sustain is 0, and stays held until note-off", () => {
    // Silent is not the same as finished: the voice is still held, and the
    // `VoiceAllocator` slot behind it is still occupied. Going `idle` here
    // desynchronises the two (see the note in `next()`).
    const env = new AdsrEnvelope(SR);
    env.noteOn({ attackSeconds: 0.001, decaySeconds: 0.005, sustainLevel: 0, releaseSeconds: 0.01 });
    for (let i = 0; i < 6; i++) env.next(); // past attack + decay
    expect(env.currentStage).toBe("sustain");
    expect(env.currentLevel).toBe(0);
    expect(env.isIdle).toBe(false);
    for (let i = 0; i < 50; i++) expect(env.next()).toBe(0);

    env.noteOff();
    expect(env.next()).toBe(0);
    expect(env.currentStage).toBe("idle");
  });

  it("releases proportionally from whatever level it was at", () => {
    const env = new AdsrEnvelope(SR);
    env.noteOn({ attackSeconds: 0.001, decaySeconds: 0.001, sustainLevel: 0.6, releaseSeconds: 0.02 });
    for (let i = 0; i < 5; i++) env.next(); // settle into sustain at 0.6
    expect(env.currentLevel).toBeCloseTo(0.6, 5);
    env.noteOff();
    expect(env.currentStage).toBe("release");
    // 20 ms release at 1000 Hz = 20 samples from 0.6 -> 0.
    for (let i = 0; i < 19; i++) env.next();
    expect(env.currentLevel).toBeGreaterThan(0);
    const last = env.next();
    expect(last).toBeCloseTo(0, 5);
    expect(env.currentStage).toBe("idle");
  });

  it("noteOff during attack releases from the interrupted level, not from 1", () => {
    const env = new AdsrEnvelope(SR);
    env.noteOn({ attackSeconds: 0.1, decaySeconds: 0.01, sustainLevel: 0.5, releaseSeconds: 0.01 });
    for (let i = 0; i < 5; i++) env.next(); // still mid-attack, well under 1
    const levelAtRelease = env.currentLevel;
    expect(levelAtRelease).toBeLessThan(1);
    env.noteOff();
    expect(env.currentStage).toBe("release");
    const next = env.next();
    expect(next).toBeLessThan(levelAtRelease); // falling, not jumping to 1 first
  });

  it("noteOff on an idle envelope is a no-op", () => {
    const env = new AdsrEnvelope(SR);
    env.noteOff();
    expect(env.currentStage).toBe("idle");
  });

  it("retriggering (noteOn while already sounding) continues from the current level", () => {
    const env = new AdsrEnvelope(SR);
    env.noteOn({ attackSeconds: 0.001, decaySeconds: 0.001, sustainLevel: 0.5, releaseSeconds: 0.01 });
    for (let i = 0; i < 5; i++) env.next();
    const levelBeforeRetrigger = env.currentLevel;
    env.noteOn({ attackSeconds: 0.01, decaySeconds: 0.01, sustainLevel: 0.7, releaseSeconds: 0.01 });
    expect(env.currentStage).toBe("attack");
    expect(env.currentLevel).toBeCloseTo(levelBeforeRetrigger, 5); // no discontinuity
  });

  it("reset forces the voice silent immediately", () => {
    const env = new AdsrEnvelope(SR);
    env.noteOn({ attackSeconds: 0.01, decaySeconds: 0.01, sustainLevel: 0.5, releaseSeconds: 0.01 });
    env.next();
    env.next();
    expect(env.currentLevel).toBeGreaterThan(0);
    env.reset();
    expect(env.currentStage).toBe("idle");
    expect(env.currentLevel).toBe(0);
  });
});
