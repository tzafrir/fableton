// Importing a sample, and restoring a project's samples on boot.
//
// The ORDER is what these tests are for: three layers move (the decoder, the
// byte store, the document), and getting the order wrong leaves orphan bytes,
// or a document that references silence.

import { describe, expect, it, vi } from "vitest";
import { createAssetStore } from "../persist/assets";
import { createMemoryProjectStorage } from "../persist/storage";
import { createProjectCommands } from "../state/commands";
import { createSequentialIdFactory } from "../state/ids";
import { createEmptyProject } from "../state/project";
import { createDocumentStore } from "../state/store";
import type { AppAssetLibrary } from "../engine/assets/library";
import type { AssetId } from "../types";
import {
  MAX_SAMPLE_BYTES,
  PEAK_COUNT,
  importSample,
  loadProjectSamples,
  peaksOf,
  type ImportableFile,
} from "./samples";

function fakeBuffer(): AudioBuffer {
  // A ramp, so `peaksOf` has something with shape to measure.
  const data = new Float32Array(44100);
  for (let i = 0; i < data.length; i++) data[i] = i / data.length;
  return {
    duration: 1,
    sampleRate: 44100,
    numberOfChannels: 2,
    length: data.length,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

/** A library that decodes whatever it is given, unless told to fail. */
function stubLibrary(options: { decodes?: boolean } = {}) {
  const held = new Map<AssetId, AudioBuffer | null>();
  const loads: AssetId[] = [];
  const library: AppAssetLibrary = {
    buffer: (id) => held.get(id) ?? undefined,
    onChange: () => () => undefined,
    load: (id, _bytes) => {
      loads.push(id);
      const buffer = options.decodes === false ? null : fakeBuffer();
      held.set(id, buffer);
      return Promise.resolve(buffer);
    },
    has: (id) => held.has(id),
    drop: (id) => void held.delete(id),
    ids: () => [...held.keys()],
    dispose: () => undefined,
  };
  return { library, held, loads };
}

function file(name: string, bytes: number): ImportableFile {
  return { name, arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)) };
}

function fixture(options: { decodes?: boolean } = {}) {
  const ids = createSequentialIdFactory();
  const commands = createProjectCommands(ids);
  const store = createDocumentStore(createEmptyProject({ ids }), { now: () => 0 });
  const storage = createMemoryProjectStorage();
  const assetStore = createAssetStore(storage);
  const { library, loads } = stubLibrary(options);
  return {
    store,
    storage,
    assetStore,
    library,
    loads,
    deps: { store, commands, assets: library, assetStore, ids },
  };
}

describe("importSample", () => {
  it("decodes, stores the bytes, and registers the asset", async () => {
    const f = fixture();
    const result = await importSample(file("kick.wav", 2048), f.deps);
    expect(result.status).toBe("imported");
    if (result.status !== "imported") return;

    const asset = f.store.getState().assets[result.assetId];
    expect(asset).toMatchObject({ name: "kick.wav", sampleRate: 44100, channels: 2, frames: 44100 });
    expect(await f.assetStore.get(result.assetId)).not.toBeNull();
  });

  it("writes NOTHING when the file will not decode", async () => {
    // A document that references silence is worse than a failed import: it
    // survives reloads and looks like a bug in the sampler.
    const f = fixture({ decodes: false });
    const result = await importSample(file("notes.txt", 64), f.deps);
    expect(result).toEqual({
      status: "rejected",
      reason: "notes.txt is not audio this browser can decode.",
    });
    expect(Object.keys(f.store.getState().assets)).toEqual([]);
    expect(await f.storage.list()).toEqual([]);
  });

  it("rejects an empty file and an oversized one before decoding either", async () => {
    const f = fixture();
    expect((await importSample(file("nothing.wav", 0), f.deps)).status).toBe("rejected");
    expect((await importSample(file("huge.wav", MAX_SAMPLE_BYTES + 1), f.deps)).status).toBe(
      "rejected",
    );
    expect(f.loads).toEqual([]); // never even handed to the decoder
  });

  it("rejects a file it cannot read, with the file's name in the message", async () => {
    const f = fixture();
    const unreadable: ImportableFile = {
      name: "locked.wav",
      arrayBuffer: () => Promise.reject(new Error("nope")),
    };
    const result = await importSample(unreadable, f.deps);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toContain("locked.wav");
  });

  it("leaves no asset in the document when storage refuses the bytes", async () => {
    const f = fixture();
    vi.spyOn(f.storage, "write").mockRejectedValueOnce(new Error("quota"));
    const result = await importSample(file("big.wav", 4096), {
      ...f.deps,
      assetStore: createAssetStore(f.storage),
    });
    expect(result.status).toBe("rejected");
    expect(Object.keys(f.store.getState().assets)).toEqual([]);
  });

  it("is undoable, and undo does not take the bytes with it", async () => {
    // Undo forgets the REFERENCE. Deleting the file's bytes would make redo
    // restore an asset that plays nothing.
    const f = fixture();
    const result = await importSample(file("snare.wav", 2048), f.deps);
    if (result.status !== "imported") throw new Error("expected an import");
    f.store.undo();
    expect(Object.keys(f.store.getState().assets)).toEqual([]);
    expect(await f.assetStore.get(result.assetId)).not.toBeNull();
    f.store.redo();
    expect(f.store.getState().assets[result.assetId]?.name).toBe("snare.wav");
  });
});

describe("loadProjectSamples", () => {
  it("decodes every asset the document references", async () => {
    const f = fixture();
    const a = await importSample(file("a.wav", 512), f.deps);
    const b = await importSample(file("b.wav", 512), f.deps);
    expect(a.status).toBe("imported");
    expect(b.status).toBe("imported");

    // A fresh library, as after a reload.
    const fresh = stubLibrary();
    const loaded = await loadProjectSamples(f.store.getState(), fresh.library, f.assetStore);
    expect(loaded).toBe(2);
  });

  it("skips what the library already holds, including what failed to decode", async () => {
    const f = fixture();
    const result = await importSample(file("a.wav", 512), f.deps);
    if (result.status !== "imported") throw new Error("expected an import");
    f.loads.length = 0;
    await loadProjectSamples(f.store.getState(), f.library, f.assetStore);
    expect(f.loads).toEqual([]); // already held: not re-read, not re-decoded
  });

  it("ignores an asset whose bytes are missing rather than throwing", async () => {
    const f = fixture();
    const result = await importSample(file("a.wav", 512), f.deps);
    if (result.status !== "imported") throw new Error("expected an import");
    await f.assetStore.remove(result.assetId);
    const fresh = stubLibrary();
    await expect(
      loadProjectSamples(f.store.getState(), fresh.library, f.assetStore),
    ).resolves.toBe(0);
  });
});

describe("peaksOf", () => {
  /** A buffer whose channel data is `make(i)`. */
  function buffer(frames: number, make: (i: number) => number, channels = 1): AudioBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    for (const channel of data) {
      for (let i = 0; i < frames; i++) channel[i] = make(i);
    }
    return {
      length: frames,
      sampleRate: 48000,
      numberOfChannels: channels,
      duration: frames / 48000,
      getChannelData: (index: number) => data[index] ?? new Float32Array(0),
    } as unknown as AudioBuffer;
  }

  it("returns one value per slice, 0..1", () => {
    const peaks = peaksOf(buffer(48000, () => 0.5));
    expect(peaks).toHaveLength(PEAK_COUNT);
    expect(peaks.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(Math.max(...peaks)).toBeCloseTo(0.5, 5);
  });

  it("takes the MAX in a slice, so a transient survives", () => {
    // The reason it is not RMS: the eye reads a waveform as an envelope, and
    // averaging turns every transient into a bump.
    const peaks = peaksOf(buffer(48000, (i) => (i === 0 ? 1 : 0)), 100);
    expect(peaks[0]).toBe(1);
    expect(peaks[1]).toBe(0);
  });

  it("folds channels together — the picture is one lane tall", () => {
    const stereo = peaksOf(buffer(1000, () => 0.25, 2), 10);
    expect(Math.max(...stereo)).toBeCloseTo(0.25, 5);
  });

  it("survives an empty buffer and rectifies negative samples", () => {
    expect(peaksOf(buffer(0, () => 0), 8)).toEqual(new Array<number>(8).fill(0));
    expect(Math.max(...peaksOf(buffer(100, () => -0.75), 4))).toBeCloseTo(0.75, 5);
  });

  it("is stored with the asset, so the arrangement can draw without decoding", async () => {
    const f = fixture();
    const result = await importSample(file("kick.wav", 2048), f.deps);
    if (result.status !== "imported") throw new Error("expected an import");
    const asset = f.store.getState().assets[result.assetId];
    expect(asset?.peaks).toHaveLength(PEAK_COUNT);
  });
});
