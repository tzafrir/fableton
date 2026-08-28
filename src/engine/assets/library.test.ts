// The decoded-asset library (SS7 `DeviceServices.assets`).

import { describe, expect, it, vi } from "vitest";
import { createAssetLibrary } from "./library";

function fakeBuffer(name = "b"): AudioBuffer {
  return { duration: 1, sampleRate: 48000, numberOfChannels: 1, length: 48000, name } as never;
}

/** A context whose `decodeAudioData` the test controls. */
function ctxWith(decode: ((bytes: ArrayBuffer) => Promise<AudioBuffer>) | null): BaseAudioContext {
  return (decode === null ? {} : { decodeAudioData: decode }) as unknown as BaseAudioContext;
}

describe("createAssetLibrary", () => {
  it("holds a decoded buffer under its id and notifies", async () => {
    const library = createAssetLibrary(ctxWith(() => Promise.resolve(fakeBuffer())));
    const changes = vi.fn();
    library.onChange(changes);
    expect(library.buffer("a")).toBeUndefined();

    await library.load("a", new ArrayBuffer(8));
    expect(library.buffer("a")).toBeDefined();
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("COPIES the bytes before decoding, because decodeAudioData detaches", async () => {
    // The caller still wants its own copy — to write to storage, for one.
    const bytes = new ArrayBuffer(8);
    let seen: ArrayBuffer | null = null;
    const library = createAssetLibrary(
      ctxWith((b) => {
        seen = b;
        return Promise.resolve(fakeBuffer());
      }),
    );
    await library.load("a", bytes);
    expect(seen).not.toBe(bytes);
    expect(bytes.byteLength).toBe(8); // still ours
  });

  it("records a FAILED decode, so the shell does not retry it forever", async () => {
    const library = createAssetLibrary(ctxWith(() => Promise.reject(new Error("bad file"))));
    expect(await library.load("a", new ArrayBuffer(4))).toBeNull();
    expect(library.has("a")).toBe(true);
    expect(library.buffer("a")).toBeUndefined();
  });

  it("returns null on a context with no decoder at all (the test fakes)", async () => {
    const library = createAssetLibrary(ctxWith(null));
    expect(await library.load("a", new ArrayBuffer(4))).toBeNull();
    expect(library.has("a")).toBe(false);
  });

  it("drops a buffer and notifies, but only when there was one", async () => {
    const library = createAssetLibrary(ctxWith(() => Promise.resolve(fakeBuffer())));
    await library.load("a", new ArrayBuffer(4));
    const changes = vi.fn();
    library.onChange(changes);
    library.drop("a");
    expect(library.buffer("a")).toBeUndefined();
    library.drop("a");
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("holds nothing and notifies nobody after dispose", async () => {
    const library = createAssetLibrary(ctxWith(() => Promise.resolve(fakeBuffer())));
    const changes = vi.fn();
    library.onChange(changes);
    library.dispose();
    expect(await library.load("a", new ArrayBuffer(4))).toBeNull();
    expect(library.ids()).toEqual([]);
    expect(changes).not.toHaveBeenCalled();
  });

  it("unsubscribes", async () => {
    const library = createAssetLibrary(ctxWith(() => Promise.resolve(fakeBuffer())));
    const changes = vi.fn();
    library.onChange(changes)();
    await library.load("a", new ArrayBuffer(4));
    expect(changes).not.toHaveBeenCalled();
  });
});
