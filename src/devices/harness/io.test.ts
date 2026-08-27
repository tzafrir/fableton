import { describe, expect, it } from "vitest";
import { PRIMARY_IN, PRIMARY_OUT, createDeviceIO } from "./io";
import { asContext, createFakeAudioContext, fakeOf } from "./testing/fakeAudio";

const ctx = () => createFakeAudioContext();

describe("createDeviceIO (SS7 ports)", () => {
  it("creates one harness-owned node per declared port", () => {
    const c = ctx();
    const { io } = createDeviceIO(asContext(c), {
      audioIn: [{ id: "in" }, { id: "sc", label: "Sidechain", optional: true }],
      audioOut: [{ id: "out" }],
    });

    expect(Object.keys(io.inputs)).toEqual(["in", "sc"]);
    expect(Object.keys(io.outputs)).toEqual(["out"]);
    expect(io.in).toBe(io.inputs[PRIMARY_IN]);
    expect(io.out).toBe(io.outputs[PRIMARY_OUT]);
    // A sidechain port exists whether or not anything is routed to it (SS6).
    expect(io.inputs["sc"]).toBeDefined();
    expect(c.created).toHaveLength(3);
  });

  it("gives an instrument an `in` node anyway — io.in is always present", () => {
    const { io } = createDeviceIO(asContext(ctx()), { audioIn: [], audioOut: [{ id: "out" }] });
    expect(io.in).toBeDefined();
    expect(Object.keys(io.inputs)).toEqual([]);
    expect(io.out).toBe(io.outputs["out"]);
  });

  it("falls back to the first declared port when none is named in/out", () => {
    const { io } = createDeviceIO(asContext(ctx()), {
      audioIn: [{ id: "left" }],
      audioOut: [{ id: "main" }, { id: "aux" }],
    });
    expect(io.in).toBe(io.inputs["left"]);
    expect(io.out).toBe(io.outputs["main"]);
  });

  it("applies an explicit channel count only when the port declares one", () => {
    const { io } = createDeviceIO(asContext(ctx()), {
      audioIn: [{ id: "in", channels: 1 }],
      audioOut: [{ id: "out" }],
    });
    const input = fakeOf(io.in);
    expect(input.channelCount).toBe(1);
    expect(input.channelCountMode).toBe("explicit");
    expect(fakeOf(io.out).channelCountMode).toBe("max");
  });

  it("refuses duplicate port ids", () => {
    expect(() =>
      createDeviceIO(asContext(ctx()), {
        audioIn: [{ id: "in" }, { id: "in" }],
        audioOut: [{ id: "out" }],
      }),
    ).toThrow(/declares port "in" twice/);
    expect(() =>
      createDeviceIO(asContext(ctx()), { audioIn: [{ id: "" }], audioOut: [{ id: "out" }] }),
    ).toThrow(/empty id/);
  });

  it("exposes frozen port maps and disconnects everything it owns on dispose", () => {
    const c = ctx();
    const bundle = createDeviceIO(asContext(c), {
      audioIn: [{ id: "in" }, { id: "sc", optional: true }],
      audioOut: [{ id: "out" }],
    });
    expect(Object.isFrozen(bundle.io.inputs)).toBe(true);
    expect(Object.isFrozen(bundle.io.outputs)).toBe(true);

    bundle.dispose();
    bundle.dispose(); // idempotent
    expect(c.created.every((node) => node.disconnectCount === 1)).toBe(true);
  });
});
