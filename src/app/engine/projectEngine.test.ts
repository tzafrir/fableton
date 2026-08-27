// Headless coverage for the app-shell's `ProjectEngine` (types/engine.ts),
// in the same style as `src/demo/engine.test.ts`: jsdom has no Web Audio, so
// this runs against `device-harness`'s `FakeAudioContext` plus a stubbed
// `AudioWorkletNode` and a `ManualClock` (SS15: "no browser needed for any of
// the load-bearing logic").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeAudioNode,
  FakeAudioParam,
  type FakeAudioContext,
  createFakeAudioContext,
} from "../../devices/harness/testing/fakeAudio";
import { createManualClock } from "../../engine/transport";
import { deviceParamId } from "../../params";
import {
  createDocumentStore,
  createEmptyProject,
  createProjectCommands,
  createSequentialIdFactory,
} from "../../state";
import type { NoteEvent, Project, ProjectSnapshot } from "../../types";
import { createProjectEngine } from "./projectEngine";
import { createDocumentNoteEventSource } from "./documentEventSource";

/**
 * `NoteEventSource.eventsInRange`'s ALLOCATION CONTRACT (SS12) licenses
 * yielding the SAME mutable event object on every step — a plain `[...it]`
 * spread would collect N references to that one object, all showing its
 * final state. Tests must copy each event out as they go, exactly like a
 * real consumer (the scheduler) is required to.
 */
function collect(events: Iterable<NoteEvent>): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const e of events) out.push({ ...e });
  return out;
}

/** `AudioWorkletNode.parameters`: a k-rate param appears the first time the
 *  device asks for it (mirrors `src/demo/engine.test.ts`'s stub). */
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

interface NoteMessage {
  type: string;
  pitch?: number;
  when: number;
}

class StubAudioWorkletNode extends FakeAudioNode {
  readonly parameters = new VivifyingParamMap();
  readonly posted: NoteMessage[] = [];
  readonly port = {
    postMessage: (message: unknown): void => {
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

function synthNode(): StubAudioWorkletNode {
  const node = workletNodes[0];
  if (node === undefined) throw new Error("no AudioWorkletNode was constructed");
  return node;
}

/** A deterministic empty project — one track holding `core.poly-synth`. */
function makeProject(): Project {
  return createEmptyProject({ ids: createSequentialIdFactory() });
}

function anyNodeConnectsTo(base: FakeAudioContext, target: object): boolean {
  return base.created.some((n) => n.connections.some((c) => c.to === target));
}

describe("createProjectEngine — mounting (SS18-M1 engine glue)", () => {
  it("mounts the default track's instrument and connects it to destination", async () => {
    const { ctx, base } = setup();
    const project = makeProject();
    const engine = createProjectEngine(ctx, base.destination as unknown as AudioNode, project, {
      clock: createManualClock(),
    });

    await engine.applyDocument(project as unknown as ProjectSnapshot);

    expect(workletNodes).toHaveLength(1);
    expect(anyNodeConnectsTo(base, base.destination)).toBe(true);

    engine.dispose();
  });

  it("skips channels without a mounted instrument (master, empty tracks)", async () => {
    const { ctx, base } = setup();
    const project = makeProject();
    const engine = createProjectEngine(ctx, base.destination as unknown as AudioNode, project, {
      clock: createManualClock(),
    });

    await engine.applyDocument(project as unknown as ProjectSnapshot);

    // One track with an instrument, one master with none: exactly one mount.
    expect(workletNodes).toHaveLength(1);
    engine.dispose();
  });

  it("unmounts an instrument whose track was deleted", async () => {
    const { ctx, base } = setup();
    const project = makeProject();
    const ids = createSequentialIdFactory();
    const commands = createProjectCommands(ids);
    const store = createDocumentStore(project);
    const engine = createProjectEngine(ctx, base.destination as unknown as AudioNode, project, {
      clock: createManualClock(),
    });

    await engine.applyDocument(store.getState());
    expect(workletNodes).toHaveLength(1);

    const trackId = project.channelOrder.find((id) => project.channels[id]?.role === "track");
    expect(trackId).toBeDefined();
    store.dispatch(commands.deleteTracks([trackId!]));
    await engine.applyDocument(store.getState());

    // The harness fades the port out on `dispose(when)` before disconnecting
    // it, so the connection count itself is timing-sensitive — what M1's
    // coarse diff owns is that the mount left the live set.
    expect(workletNodes).toHaveLength(1); // no NEW worklet was constructed
    engine.dispose();
  });

  it("backfills a newly mounted device's params from the document (SS4 load)", async () => {
    const { ctx, base } = setup();
    const project = makeProject();
    const track = project.channelOrder.find((id) => project.channels[id]?.role === "track")!;
    const deviceId = project.channels[track]!.source!.deviceId;
    const gainParamId = deviceParamId(track, deviceId, "gain");
    project.paramValues[gainParamId] = -9;

    const engine = createProjectEngine(ctx, base.destination as unknown as AudioNode, project, {
      clock: createManualClock(),
    });
    await engine.applyDocument(project as unknown as ProjectSnapshot);

    expect(engine.params.require(gainParamId).base()).toBe(-9);
    engine.dispose();
  });
});

describe("createProjectEngine — audition (SS10)", () => {
  it("is undefined before the track's instrument is mounted", () => {
    const { ctx, base } = setup();
    const project = makeProject();
    const track = project.channelOrder.find((id) => project.channels[id]?.role === "track")!;
    const engine = createProjectEngine(ctx, base.destination as unknown as AudioNode, project, {
      clock: createManualClock(),
    });
    expect(engine.auditionFor(track)).toBeUndefined();
    engine.dispose();
  });

  it("plays immediately at ctx.currentTime, never scheduled (SS10)", async () => {
    const { ctx, base } = setup(1.5);
    const project = makeProject();
    const track = project.channelOrder.find((id) => project.channels[id]?.role === "track")!;
    const engine = createProjectEngine(ctx, base.destination as unknown as AudioNode, project, {
      clock: createManualClock(),
    });
    await engine.applyDocument(project as unknown as ProjectSnapshot);

    const audition = engine.auditionFor(track);
    expect(audition).toBeDefined();
    audition!.noteOn(60, 100);
    audition!.noteOff(60);

    const posted = synthNode().posted;
    expect(posted.some((m) => m.type === "noteOn" && m.pitch === 60 && m.when === 1.5)).toBe(true);
    expect(posted.some((m) => m.type === "noteOff" && m.pitch === 60 && m.when === 1.5)).toBe(true);

    engine.dispose();
  });
});

describe("createDocumentNoteEventSource — SS3/SS12 re-pointing", () => {
  it("makes an edit audible without rebuilding the transport", () => {
    const project = makeProject();
    const track = project.channelOrder.find((id) => project.channels[id]?.role === "track")!;
    const clipId = Object.keys(project.clips)[0]!;

    const source = createDocumentNoteEventSource(project as unknown as ProjectSnapshot);
    expect(collect(source.eventsInRange(0, 480))).toHaveLength(0); // empty clip

    const edited: Project = {
      ...project,
      clips: {
        ...project.clips,
        [clipId]: {
          ...project.clips[clipId]!,
          trackId: track,
          notes: [{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }],
        },
      },
    };
    source.setDocument(edited as unknown as ProjectSnapshot);

    const events = collect(source.eventsInRange(0, 480));
    expect(events.some((e) => e.type === "noteOn" && e.pitch === 60)).toBe(true);
  });

  it("a fresh scan after setDocument never yields an orphan note-off", () => {
    // A note whose note-on this pass never emitted (it was removed by the
    // edit) must not leave a dangling note-off — the discontinuity contract
    // `types/engine.ts` calls out.
    const project = makeProject();
    const track = project.channelOrder.find((id) => project.channels[id]?.role === "track")!;
    const clipId = Object.keys(project.clips)[0]!;
    const withNote: Project = {
      ...project,
      clips: {
        ...project.clips,
        [clipId]: {
          ...project.clips[clipId]!,
          trackId: track,
          notes: [{ id: "n1", start: 0, dur: 240, pitch: 60, vel: 100 }],
        },
      },
    };

    const source = createDocumentNoteEventSource(withNote as unknown as ProjectSnapshot);
    // Consume the note-on but stop before the note-off tick.
    const first = collect(source.eventsInRange(0, 100));
    expect(first).toEqual([expect.objectContaining({ type: "noteOn", pitch: 60 })]);

    // The edit deletes the note entirely; a fresh scan must not later emit
    // its note-off out of a stale cursor.
    const withoutNote: Project = {
      ...withNote,
      clips: { ...withNote.clips, [clipId]: { ...withNote.clips[clipId]!, notes: [] } },
    };
    source.setDocument(withoutNote as unknown as ProjectSnapshot);
    const rest = collect(source.eventsInRange(100, 480));
    expect(rest).toHaveLength(0);
  });
});
