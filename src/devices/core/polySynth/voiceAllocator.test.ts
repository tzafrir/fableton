import { describe, expect, it } from "vitest";
import { VoiceAllocator } from "./voiceAllocator";

describe("VoiceAllocator", () => {
  it("starts with every voice free", () => {
    const alloc = new VoiceAllocator(4);
    for (let i = 0; i < 4; i++) expect(alloc.pitchOf(i)).toBeNull();
  });

  it("assigns distinct voices to distinct pitches until the pool is full", () => {
    const alloc = new VoiceAllocator(3);
    const a = alloc.allocate(60);
    const b = alloc.allocate(62);
    const c = alloc.allocate(64);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(alloc.pitchOf(a)).toBe(60);
    expect(alloc.pitchOf(b)).toBe(62);
    expect(alloc.pitchOf(c)).toBe(64);
  });

  it("reuses a freed voice before stealing", () => {
    const alloc = new VoiceAllocator(2);
    const a = alloc.allocate(60);
    alloc.allocate(62);
    alloc.release(60);
    const reused = alloc.allocate(64);
    expect(reused).toBe(a);
    expect(alloc.pitchOf(a)).toBe(64);
  });

  it("steals the oldest-triggered voice once every voice is busy", () => {
    const alloc = new VoiceAllocator(2);
    const first = alloc.allocate(60);
    const second = alloc.allocate(62);
    const stolen = alloc.allocate(64); // both busy -> steals `first` (60, triggered earlier)
    expect(stolen).toBe(first);
    expect(alloc.pitchOf(first)).toBe(64);
    expect(alloc.pitchOf(second)).toBe(62); // untouched
  });

  it("gives two overlapping notes of the same pitch two voices", () => {
    // The scheduler's sounding-note ledger is one entry per note OCCURRENCE,
    // deliberately not deduplicated by (pitch, track), because a clip may hold
    // two overlapping notes of one pitch (M1's piano roll lets a user draw
    // it). Sharing one voice would let the FIRST note-off release both.
    const alloc = new VoiceAllocator(4);
    const first = alloc.allocate(60);
    const second = alloc.allocate(60);
    expect(second).not.toBe(first);

    // The first note-off releases the older voice; the later note keeps
    // sounding until its own note-off.
    expect(alloc.release(60)).toBe(first);
    expect(alloc.pitchOf(second)).toBe(60);
    expect(alloc.release(60)).toBe(second);
    expect(alloc.pitchOf(second)).toBeNull();
    expect(alloc.release(60)).toBeNull();
  });

  it("release returns null for a pitch that is not sounding", () => {
    const alloc = new VoiceAllocator(2);
    expect(alloc.release(60)).toBeNull();
  });

  it("release frees the voice so it is reported as null and available again", () => {
    const alloc = new VoiceAllocator(2);
    const index = alloc.allocate(60);
    expect(alloc.release(60)).toBe(index);
    expect(alloc.pitchOf(index)).toBeNull();
  });

  it("clear frees every voice", () => {
    const alloc = new VoiceAllocator(3);
    alloc.allocate(60);
    alloc.allocate(62);
    alloc.clear();
    for (let i = 0; i < 3; i++) expect(alloc.pitchOf(i)).toBeNull();
  });

  it("clear keeps the last-used stamps, so a panic does not truncate release tails", () => {
    // `allNotesOff` — every transport stop, seek and tempo change while playing
    // (SS12) — RELEASES its voices; they are still audibly ringing out. Wiping
    // the stamps would send the pool back to lowest-index allocation, so each
    // of the next notes would steal a voice that is still sounding.
    const alloc = new VoiceAllocator(4);
    const used: number[] = [];
    for (let i = 0; i < 4; i++) {
      const pitch = 60 + i;
      used.push(alloc.allocate(pitch));
      alloc.release(pitch);
      if (i === 1) alloc.clear(); // a panic lands mid-melody
    }
    expect(new Set(used).size).toBe(4);
  });

  it("spreads a monophonic melody across the pool instead of hammering voice 0", () => {
    // A released voice is still ringing out its envelope release; reusing the
    // lowest free index would truncate every tail (§7 tails, §14 voice layer).
    const alloc = new VoiceAllocator(4);
    const used: number[] = [];
    for (let i = 0; i < 8; i++) {
      const pitch = 60 + i;
      used.push(alloc.allocate(pitch));
      alloc.release(pitch);
    }
    expect(used.slice(0, 4)).toEqual([0, 1, 2, 3]); // every silent voice first
    expect(used.slice(4)).toEqual([0, 1, 2, 3]); // then round again, oldest first
  });

  it("prefers a never-used voice over a recently released one", () => {
    const alloc = new VoiceAllocator(3);
    alloc.allocate(60);
    alloc.release(60); // voice 0 is free but still ringing
    expect(alloc.allocate(62)).toBe(1);
  });

  it("rejects a non-positive voice count", () => {
    expect(() => new VoiceAllocator(0)).toThrow();
    expect(() => new VoiceAllocator(-1)).toThrow();
    expect(() => new VoiceAllocator(1.5)).toThrow();
  });
});
