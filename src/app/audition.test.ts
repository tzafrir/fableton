// SS10/SS7 — the audition proxy resolves its target PER NOTE.

import { describe, expect, it, vi } from "vitest";
import type { AuditionSink } from "../types";
import { createAuditionProxy } from "./audition";

function sink(): AuditionSink & { noteOn: ReturnType<typeof vi.fn> } {
  return {
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    allNotesOff: vi.fn(),
  } as unknown as AuditionSink & { noteOn: ReturnType<typeof vi.fn> };
}

describe("createAuditionProxy", () => {
  it("follows the current target instead of caching the first one", () => {
    const before = sink();
    const after = sink();
    let current: AuditionSink | undefined = before;
    const proxy = createAuditionProxy(() => current);

    proxy.noteOn(60, 100);
    expect(before.noteOn).toHaveBeenCalledWith(60, 100);

    // An SS7 instrument swap remounts the device: `auditionFor` now returns a
    // sink bound to the NEW instance. A cached proxy would keep playing into
    // the disposed one (i.e. silently do nothing) until the clip is reopened.
    current = after;
    proxy.noteOn(64, 90);
    expect(after.noteOn).toHaveBeenCalledWith(64, 90);
    expect(before.noteOn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op while no target resolves (no engine, no open clip)", () => {
    const proxy = createAuditionProxy(() => undefined);
    expect(() => {
      proxy.noteOn(60, 100);
      proxy.noteOff(60);
      proxy.allNotesOff();
    }).not.toThrow();
  });
});
