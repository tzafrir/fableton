import { describe, expect, it } from "vitest";
import {
  ALL_NOTES_OFF,
  NOTE_OFF,
  NOTE_ON,
  NoteEventQueue,
  type QueuedNoteEvent,
} from "./noteEventQueue";

const SR = 48000;
const BLOCK = 128;
const BLOCK_SECONDS = BLOCK / SR;

/** Snapshot of the due buffer, for readable assertions. */
function drain(
  q: NoteEventQueue,
  blockStart: number,
): Array<{ type: number; pitch: number; vel: number; offset: number }> {
  const count = q.collectDue(blockStart, SR, BLOCK);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ type: q.typeAt(i), pitch: q.pitchAt(i), vel: q.velAt(i), offset: q.offsetAt(i) });
  }
  return out;
}

describe("NoteEventQueue", () => {
  it("is empty until events are pushed", () => {
    const q = new NoteEventQueue();
    expect(q.size).toBe(0);
    expect(drain(q, 0)).toEqual([]);
  });

  it("holds a future event until its block comes due", () => {
    const q = new NoteEventQueue();
    q.push({ type: "noteOn", pitch: 60, vel: 100, when: 1.0 });
    expect(drain(q, 0)).toEqual([]); // block [0, BLOCK_SECONDS) is too early
    expect(q.size).toBe(1);
    expect(drain(q, 1.0)).toEqual([{ type: NOTE_ON, pitch: 60, vel: 100, offset: 0 }]);
    expect(q.size).toBe(0); // consumed
  });

  it("returns due events ordered by sample offset, not push order", () => {
    const q = new NoteEventQueue();
    q.push({ type: "noteOn", pitch: 64, vel: 100, when: 1.0 + BLOCK_SECONDS * 0.75 });
    q.push({ type: "noteOn", pitch: 60, vel: 100, when: 1.0 + BLOCK_SECONDS * 0.25 });
    const due = drain(q, 1.0);
    expect(due.map((d) => d.pitch)).toEqual([60, 64]);
    expect(due[0]!.offset).toBeLessThan(due[1]!.offset);
  });

  it("keeps arrival order for events landing on the same sample", () => {
    const q = new NoteEventQueue();
    q.push({ type: "noteOff", pitch: 60, when: 1.0 });
    q.push({ type: "noteOn", pitch: 60, vel: 90, when: 1.0 });
    // The loop brace re-triggers a held pitch at the wrap instant: the cut
    // must still be applied before the re-attack (§12 loop unrolling).
    expect(drain(q, 1.0).map((d) => d.type)).toEqual([NOTE_OFF, NOTE_ON]);
  });

  it("leaves not-yet-due events queued and drains only what is due", () => {
    const q = new NoteEventQueue();
    q.push({ type: "noteOn", pitch: 60, vel: 100, when: 0.5 });
    q.push({ type: "noteOff", pitch: 60, when: 5.0 });
    expect(drain(q, 0.5)).toEqual([{ type: NOTE_ON, pitch: 60, vel: 100, offset: 0 }]);
    expect(q.size).toBe(1); // the note-off is still pending
  });

  it("an allNotesOff event round-trips like any other", () => {
    const q = new NoteEventQueue();
    q.push({ type: "allNotesOff", when: 2.0 });
    expect(drain(q, 2.0).map((d) => d.type)).toEqual([ALL_NOTES_OFF]);
  });

  it("allNotesOff cancels every event queued at or after its time (§12 stop)", () => {
    const q = new NoteEventQueue();
    // The 200 ms look-ahead already handed the worklet these:
    q.push({ type: "noteOn", pitch: 60, vel: 100, when: 1.0 });
    q.push({ type: "noteOn", pitch: 67, vel: 100, when: 1.1 });
    q.push({ type: "noteOff", pitch: 67, when: 1.3 });
    // ...then the user pressed Stop at 1.05 s.
    q.push({ type: "allNotesOff", when: 1.05 });

    expect(q.size).toBe(2); // the note-on at 1.0 (already past) + the panic
    const early = drain(q, 1.0);
    expect(early.map((d) => d.pitch)).toEqual([60]);
    const panic = drain(q, 1.05);
    expect(panic.map((d) => d.type)).toEqual([ALL_NOTES_OFF]);
    expect(q.size).toBe(0); // nothing survives to sound after the panic
  });

  it("events pushed after an allNotesOff are untouched (seek re-schedules)", () => {
    const q = new NoteEventQueue();
    q.push({ type: "allNotesOff", when: 1.0 });
    q.push({ type: "noteOn", pitch: 72, vel: 100, when: 1.005 });
    expect(q.size).toBe(2);
    expect(drain(q, 1.005).map((d) => d.pitch)).toEqual([-1, 72]);
  });

  it("drops a malformed message instead of treating it as a panic", () => {
    // `port.onmessage` is an untrusted boundary. An unknown `type` used to
    // fall through to ALL_NOTES_OFF, which on the render thread releases every
    // voice at the top of the next quantum.
    const q = new NoteEventQueue();
    q.push({ type: "noteOn", pitch: 60, vel: 100, when: 1 });
    q.push({ type: "wat", pitch: 60, when: 1 } as unknown as QueuedNoteEvent);
    q.push({ type: "noteOff", pitch: 60 } as unknown as QueuedNoteEvent);

    expect(q.size).toBe(1);
    expect(q.dropped).toBe(2);
    expect(drain(q, 1).map((d) => d.pitch)).toEqual([60]);
  });

  it("counts, rather than grows past, an overfull ring", () => {
    const q = new NoteEventQueue(2);
    const ev: QueuedNoteEvent = { type: "noteOn", pitch: 60, vel: 100, when: 9 };
    q.push(ev);
    q.push(ev);
    q.push(ev);
    expect(q.size).toBe(2);
    expect(q.dropped).toBe(1);
  });
});
