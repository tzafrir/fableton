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
import type { AutomationLane, MidiClip, NoteEvent, Project, ProjectSnapshot } from "../../types";
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

/** The project's single track, its instrument, and its one clip. */
function parts(project: Project): { track: string; deviceId: string; clipId: string } {
  const track = project.channelOrder.find((id) => project.channels[id]?.role === "track")!;
  const deviceId = project.channels[track]!.source!.deviceId;
  const clipId = Object.keys(project.clips)[0]!;
  return { track, deviceId, clipId };
}

/** The same project with one note in its clip — enough for the transport to
 *  have something scheduled (and therefore something to panic about). */
function withNote(project: Project, start = 0): Project {
  const { track, clipId } = parts(project);
  const clip: MidiClip = {
    ...project.clips[clipId]!,
    trackId: track,
    notes: [{ id: "n1", start, dur: 240, pitch: 60, vel: 100 }],
  };
  return { ...project, clips: { ...project.clips, [clipId]: clip } };
}

describe("createProjectEngine — applying while the transport plays (SS2/SS12)", () => {
  it("leaves the transport alone when an edit does not change the tempo", async () => {
    const { ctx, base } = setup();
    const project = withNote(makeProject());
    const engine = createProjectEngine(ctx, base.destination as unknown as AudioNode, project, {
      clock: createManualClock(),
    });
    await engine.applyDocument(project as unknown as ProjectSnapshot);
    engine.transport.play();
    const node = synthNode();
    // The first look-ahead window handed the note to the instrument; it is
    // now sounding, and it is what a panic would cut.
    expect(node.posted.some((m) => m.type === "noteOn")).toBe(true);
    node.posted.length = 0;

    // An ordinary mid-playback edit: one more note, far outside the window.
    const { clipId } = parts(project);
    const edited: Project = {
      ...project,
      clips: {
        ...project.clips,
        [clipId]: {
          ...project.clips[clipId]!,
          notes: [...project.clips[clipId]!.notes, { id: "n2", start: 480, dur: 240, pitch: 64, vel: 100 }],
        },
      },
    };
    await engine.applyDocument(edited as unknown as ProjectSnapshot);

    // `setTempoMap` panics whenever the transport is not stopped: every
    // pending note-on gets a note-off at its own onset and every played track
    // an `allNotesOff`. Pushing an unchanged map therefore silenced the whole
    // project on EVERY edit made during playback.
    expect(node.posted.filter((m) => m.type === "allNotesOff")).toHaveLength(0);
    expect(node.posted.filter((m) => m.type === "noteOff")).toHaveLength(0);

    engine.dispose();
  });

  it("still re-anchors when the tempo really changes", async () => {
    const { ctx, base } = setup();
    const project = withNote(makeProject());
    const engine = createProjectEngine(ctx, base.destination as unknown as AudioNode, project, {
      clock: createManualClock(),
    });
    await engine.applyDocument(project as unknown as ProjectSnapshot);
    engine.transport.play();
    const node = synthNode();
    node.posted.length = 0;

    const faster: Project = { ...project, tempo: [{ startTick: 0, bpm: 140 }] };
    await engine.applyDocument(faster as unknown as ProjectSnapshot);

    expect(engine.transport.tempoMap.bpmAt(0)).toBe(140);
    expect(node.posted.some((m) => m.type === "allNotesOff")).toBe(true);
    engine.dispose();
  });
});

describe("createProjectEngine — a failed apply (SS3/SS6)", () => {
  it("reports the error and keeps following the document afterwards", async () => {
    const { ctx, base } = setup();
    const project = makeProject();
    // The instrument's `prepare()` is `audioWorklet.addModule` — the one step
    // of a mount that talks to the network and can genuinely fail.
    let failNextModule = true;
    base.audioWorklet.addModule = (url: string): Promise<void> => {
      if (failNextModule) {
        failNextModule = false;
        return Promise.reject(new Error("module load failed"));
      }
      base.addedModules.push(url);
      return Promise.resolve();
    };

    const engine = createProjectEngine(ctx, base.destination as unknown as AudioNode, project, {
      clock: createManualClock(),
    });
    const errors: unknown[] = [];
    engine.onApplyError((error) => errors.push(error));

    await engine.applyDocument(project as unknown as ProjectSnapshot);
    expect(errors).toHaveLength(1);
    expect(workletNodes).toHaveLength(0);

    // The whole point: the serializing queue is still usable. Before the
    // `.catch`, the rejection stayed in `queue` and every later apply was
    // skipped — the engine stopped following the document for the rest of the
    // session, silently.
    const { track, deviceId } = parts(project);
    await engine.applyDocument(project as unknown as ProjectSnapshot);
    expect(workletNodes).toHaveLength(1);
    expect(engine.auditionFor(track)).toBeDefined();
    expect(engine.params.get(deviceParamId(track, deviceId, "cutoff"))).toBeDefined();

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

describe("createProjectEngine — automated params at load (SS4/SS11)", () => {
  it("pushes an automated param's SAVED value to the DSP, not the descriptor default", async () => {
    const { ctx, base } = setup();
    const project = makeProject();
    const { track, deviceId } = parts(project);
    const cutoffId = deviceParamId(track, deviceId, "cutoff");
    project.paramValues[cutoffId] = 400; // descriptor default is 8000 Hz
    const lane: AutomationLane = {
      id: "lane1",
      channelId: track,
      paramId: cutoffId,
      points: [{ t: 0, v: 12000, curve: 0 }],
      enabled: true,
    };
    project.lanes[lane.id] = lane;

    const engine = createProjectEngine(ctx, base.destination as unknown as AudioNode, project, {
      clock: createManualClock(),
    });
    await engine.applyDocument(project as unknown as ProjectSnapshot);

    const handle = engine.params.require(cutoffId);
    expect(handle.state).toBe("automated");
    expect(handle.base()).toBe(400);
    // `setBase` writes through to the binding only while the param is `free`
    // (SS4), so loading AFTER `setAutomatedIds` left the device mounted at
    // its descriptor default while the knob showed the saved value — audible
    // on any pre-playback audition.
    expect(handle.live()).toBe(400);

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
