import { describe, expect, it } from "vitest";
import { PARAM_PATH_SEPARATOR, deviceParamId } from "../params";
import { createIdFactory, createSequentialIdFactory } from "./ids";

describe("createIdFactory", () => {
  it("mints unique ids per kind", () => {
    const ids = createIdFactory();
    const minted = [
      ids.project(),
      ids.channel(),
      ids.channel(),
      ids.device(),
      ids.clip(),
      ids.note(),
      ids.lane(),
    ];
    expect(new Set(minted).size).toBe(minted.length);
  });

  it("never emits the ParamId path separator (SS4 ids are built from these)", () => {
    const random = () => 0.999999;
    const ids = createIdFactory({ random, namespace: "tab2" });
    for (let i = 0; i < 200; i++) {
      const id = ids.channel();
      expect(id.includes(PARAM_PATH_SEPARATOR)).toBe(false);
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
    expect(() => deviceParamId(ids.channel(), ids.device(), "cutoff")).not.toThrow();
  });

  it("does not collide when two factories share a random source", () => {
    // The counter half of the token is what keeps a single session unique even
    // when randomness repeats.
    const ids = createIdFactory({ random: () => 0.5 });
    const minted = Array.from({ length: 100 }, () => ids.note());
    expect(new Set(minted).size).toBe(100);
  });
});

describe("createSequentialIdFactory", () => {
  it("counts per kind, from 1", () => {
    const ids = createSequentialIdFactory();
    expect([ids.channel(), ids.channel(), ids.clip(), ids.note()]).toEqual([
      "chan-1",
      "chan-2",
      "clip-1",
      "note-1",
    ]);
  });

  it("namespaces so two fixtures in one test cannot collide", () => {
    expect(createSequentialIdFactory("b").clip()).toBe("clip-b-1");
  });
});
