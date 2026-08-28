// The asset byte store: base64 round-trips, and the key-prefix rule that
// keeps a sample from being mistaken for a project.

import { describe, expect, it } from "vitest";
import {
  ASSET_KEY_PREFIX,
  assetStorageKey,
  base64ToBytes,
  bytesToBase64,
  createAssetStore,
  isAssetKey,
} from "./assets";
import { createMemoryProjectStorage } from "./storage";
import { loadOrCreateProject } from "./loadOrCreate";
import { projectCodec } from "./codec";
import { createEmptyProject } from "../state/project";
import { createSequentialIdFactory } from "../state/ids";

describe("base64", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });

  it("round-trips a buffer larger than the chunking limit", () => {
    // The classic base64 bug: `String.fromCharCode(...bytes)` blows the
    // argument limit, and only ever on the files big enough to matter.
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const round = base64ToBytes(bytesToBase64(bytes));
    expect(round.length).toBe(bytes.length);
    expect(round[0]).toBe(0);
    expect(round[199_999]).toBe(bytes[199_999]);
  });

  it("round-trips an empty buffer", () => {
    expect(base64ToBytes(bytesToBase64(new Uint8Array(0))).length).toBe(0);
  });
});

describe("the asset store", () => {
  it("puts, gets and removes", async () => {
    const storage = createMemoryProjectStorage();
    const store = createAssetStore(storage);
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    await store.put("asset-1", bytes);
    const back = await store.get("asset-1");
    expect(back).not.toBeNull();
    expect([...new Uint8Array(back!)]).toEqual([1, 2, 3, 4]);
    expect(await store.list()).toEqual(["asset-1"]);
    await store.remove("asset-1");
    expect(await store.get("asset-1")).toBeNull();
  });

  it("returns a buffer safe to hand to decodeAudioData", async () => {
    // `decodeAudioData` DETACHES its argument, so a view into a shared pool
    // would take the pool with it.
    const store = createAssetStore(createMemoryProjectStorage());
    await store.put("a", new Uint8Array([9, 9]).buffer);
    const back = await store.get("a");
    expect(back?.byteLength).toBe(2);
  });

  it("is null for a slot that was never written", async () => {
    expect(await createAssetStore(createMemoryProjectStorage()).get("nope")).toBeNull();
  });

  it("keys under a reserved prefix", () => {
    expect(assetStorageKey("a1")).toBe(`${ASSET_KEY_PREFIX}a1`);
    expect(isAssetKey(assetStorageKey("a1"))).toBe(true);
    expect(isAssetKey("prj-1")).toBe(false);
  });
});

describe("assets and project discovery", () => {
  it("never opens a sample as if it were the project", async () => {
    // The bug this rules out: `loadOrCreateProject` takes the NEWEST key in
    // storage, so importing a sample would make the next reload try to open
    // that sample as a song.
    const storage = createMemoryProjectStorage();
    const project = createEmptyProject({ ids: createSequentialIdFactory(), name: "Real" });
    await storage.write(project.id, projectCodec.encode(project));
    await createAssetStore(storage).put("asset-newest", new Uint8Array([1, 2, 3]).buffer);

    const result = await loadOrCreateProject(storage, projectCodec, {
      createEmptyProject: () => createEmptyProject({ ids: createSequentialIdFactory() }),
    });
    expect(result.project.name).toBe("Real");
  });
});
