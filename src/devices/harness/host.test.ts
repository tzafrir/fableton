import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateDeviceHost,
  DeviceDefinition,
  DeviceIO,
  DeviceInstance,
} from "../../types";
import { createParamRegistry, type AppParamRegistry } from "../../params/registry";
import { deviceParamId } from "../../params/paramIds";
import { createDeviceHost, createHost, prepareDefinition } from "./host";
import { createDeviceRegistry, type AppDeviceRegistry } from "./registry";
import { deviceInstance, msParam } from "./deviceInstance";
import { p } from "./params";
import {
  asContext,
  collectingScheduler,
  connectedNodeTypes,
  createFakeAudioContext,
  delaysOf,
  fakeOf,
  gainsOf,
  type FakeAudioContext,
  fakeServices,
} from "./testing/fakeAudio";

let ctx: FakeAudioContext;
let params: AppParamRegistry;
let devices: AppDeviceRegistry;
let timers: ReturnType<typeof collectingScheduler>;

/** SS14's delay, trimmed to what the lifecycle test needs. */
function delayDef(overrides: Partial<DeviceDefinition> = {}): DeviceDefinition {
  return {
    id: "core.stereo-delay",
    version: 1,
    kind: "audioEffect",
    label: "Stereo Delay",
    params: [
      p.time("timeL", "Time L", { min: 1, max: 2000, default: 250 }),
      p.pct("mix", "Mix", { default: 25 }),
    ],
    audioIn: [{ id: "in" }, { id: "sc", optional: true }],
    audioOut: [{ id: "out" }],
    create(c: BaseAudioContext, io: DeviceIO): DeviceInstance {
      const delay = c.createDelay(2);
      const wet = c.createGain();
      io.in.connect(delay);
      delay.connect(wet);
      wet.connect(io.out);
      return deviceInstance({
        scaledParams: { timeL: msParam(delay.delayTime) },
        gainParams: { mix: wet },
        dispose: () => {
          wet.disconnect();
          delay.disconnect();
        },
      });
    },
    ...overrides,
  };
}

function host() {
  return createDeviceHost(asContext(ctx), params, devices, { schedule: timers.schedule });
}

beforeEach(() => {
  ctx = createFakeAudioContext({ currentTime: 5 });
  params = createParamRegistry({ now: () => ctx.currentTime, schedule: () => 0 });
  devices = createDeviceRegistry();
  timers = collectingScheduler();
});

describe("DeviceHost.mount — the SS7 lifecycle in one place", () => {
  it("prepares, creates, registers every descriptor and binds it", async () => {
    const def = delayDef();
    devices.register(def);
    const mounted = await host().mount({
      definition: def,
      instanceId: "d12",
      channelId: "g4",
    });

    expect(mounted.id).toBe("d12");
    expect(mounted.channelId).toBe("g4");
    expect(mounted.definition).toBe(def);
    expect(mounted.input).toBe(mounted.io.in);
    expect(mounted.output).toBe(mounted.io.out);
    expect(mounted.io.inputs["sc"]).toBeDefined();

    // Registered under the SS4 path, never under the device-local id.
    const timeId = deviceParamId("g4", "d12", "timeL");
    expect(mounted.paramId("timeL")).toBe(timeId);
    expect(mounted.paramId("nope")).toBeUndefined();
    expect(params.has(timeId)).toBe(true);
    expect(params.has("timeL")).toBe(false);
    expect(params.list().map((h) => h.desc.id).sort()).toEqual(
      [timeId, deviceParamId("g4", "d12", "mix")].sort(),
    );
    // The descriptor inside the definition is untouched — definitions are
    // shared by every instance of the device.
    expect(def.params[0]?.id).toBe("timeL");

    // Bound: writing the handle reaches the node, with the ms -> s scaling.
    const delayNode = delaysOf(ctx)[0];
    mounted.params.get("timeL")?.setLive(500, "user");
    expect(delayNode?.delayTime.value).toBeCloseTo(0.5, 10);
  });

  it("wires the device's nodes to the harness-owned ports, not to the graph", async () => {
    const def = delayDef();
    const mounted = await host().mount({ definition: def, instanceId: "d1", channelId: "t1" });
    const inNode = fakeOf(mounted.io.in);
    const outNode = fakeOf(mounted.io.out);
    expect(connectedNodeTypes(inNode)).toEqual(["delay"]);
    // Nothing outside the device has been touched: the caller owns that.
    expect(outNode.connections).toHaveLength(0);
    expect(ctx.destination.connections).toHaveLength(0);
  });

  it("runs `prepare` once per context, even across mounts and hosts", async () => {
    const prepare = vi.fn(async (c: BaseAudioContext) => {
      await (c as unknown as FakeAudioContext).audioWorklet.addModule("voice.js");
    });
    const def = delayDef({ id: "core.synth", prepare });
    const created: number[] = [];
    const definition: DeviceDefinition = {
      ...def,
      create(c, io) {
        created.push(created.length);
        return def.create(c, io, fakeServices());
      },
    };

    const h1 = host();
    await h1.mount({ definition, instanceId: "d1", channelId: "t1" });
    await h1.mount({ definition, instanceId: "d2", channelId: "t2" });
    await host().mount({ definition, instanceId: "d3", channelId: "t3" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(ctx.addedModules).toEqual(["voice.js"]);
    expect(created).toHaveLength(3);

    // A different context prepares on its own (M4's offline export).
    const other = createFakeAudioContext();
    await createDeviceHost(asContext(other), createParamRegistry({ schedule: () => 0 }), devices)
      .mount({ definition, instanceId: "d4", channelId: "t4" });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("lets a failed prepare be retried instead of poisoning the context", async () => {
    let attempts = 0;
    const definition = delayDef({
      id: "core.flaky",
      prepare: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("addModule failed");
      },
    });
    const h = host();
    await expect(h.mount({ definition, instanceId: "d1", channelId: "t1" })).rejects.toThrow(
      /addModule failed/,
    );
    await expect(
      h.mount({ definition, instanceId: "d1", channelId: "t1" }),
    ).resolves.toBeDefined();
    expect(attempts).toBe(2);
    await expect(prepareDefinition(asContext(ctx), definition)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("refuses a duplicate instance id and rejects once disposed", async () => {
    const definition = delayDef();
    const h = host();
    await h.mount({ definition, instanceId: "d1", channelId: "t1" });
    await expect(h.mount({ definition, instanceId: "d1", channelId: "t2" })).rejects.toThrow(
      /already mounted/,
    );
    h.dispose();
    await expect(h.mount({ definition, instanceId: "d9", channelId: "t1" })).rejects.toThrow(
      /disposed/,
    );
  });

  it("rolls back cleanly when create or registration throws", async () => {
    const boom = delayDef({
      id: "core.boom",
      create: () => {
        throw new Error("bad DSP");
      },
    });
    await expect(host().mount({ definition: boom, instanceId: "d1", channelId: "t1" })).rejects
      .toThrow(/bad DSP/);
    expect(ctx.created.every((n) => n.disconnectCount === 1)).toBe(true);
    expect(params.list()).toEqual([]);

    // A param id collision half way through registration leaves nothing behind.
    const dup = delayDef({ id: "core.dup" });
    const disposed = vi.fn();
    const definition: DeviceDefinition = {
      ...dup,
      create: () => deviceInstance({ dispose: disposed }),
    };
    const h = host();
    params.register({ ...definition.params[1]!, id: deviceParamId("t1", "d2", "mix") });
    await expect(h.mount({ definition, instanceId: "d2", channelId: "t1" })).rejects.toThrow(
      /already registered/,
    );
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(params.list().map((h2) => h2.desc.id)).toEqual([deviceParamId("t1", "d2", "mix")]);
    expect(h.get("d2")).toBeUndefined();
  });
});

describe("DeviceHost removal — the reverse, gain-ramped (SS7)", () => {
  it("unregisters and unbinds params before the instance fades", async () => {
    const definition = delayDef();
    const h = host();
    const mounted = await h.mount({ definition, instanceId: "d1", channelId: "t1" });
    // The device's own wet gain is the last gain created: the three port
    // nodes come first, then `create` builds the delay and the wet gain.
    const wet = gainsOf(ctx).at(-1)!;
    const handle = mounted.params.get("mix")!;
    const disposeSpy = vi.spyOn(mounted.instance, "dispose");

    mounted.dispose(ctx.currentTime + 0.02);

    expect(params.has(deviceParamId("t1", "d1", "mix"))).toBe(false);
    expect(params.list()).toEqual([]);
    expect(h.get("d1")).toBeUndefined();
    expect(disposeSpy).toHaveBeenCalledWith(ctx.currentTime + 0.02);

    // Nothing a stale knob does can reach a node that is being torn down.
    const eventsBefore = wet.gain.events.length;
    expect(eventsBefore).toBeGreaterThan(0); // it really was bound
    handle.setLive(90, "user");
    expect(wet.gain.events.length).toBe(eventsBefore);
  });

  it("keeps the port nodes alive until the fade has passed", async () => {
    const definition = delayDef();
    const mounted = await host().mount({ definition, instanceId: "d1", channelId: "t1" });
    const port = fakeOf(mounted.io.out);

    mounted.dispose(ctx.currentTime + 0.5);
    expect(port.disconnectCount).toBe(0);
    expect(timers.calls[0]?.ms).toBeGreaterThanOrEqual(500);

    // The timer only wakes the check; the AUDIO clock decides. Until it has
    // passed the fade, waking early re-arms instead of cutting.
    timers.runAll();
    expect(port.disconnectCount).toBe(0);

    ctx.currentTime += 1;
    timers.runAll();
    expect(port.disconnectCount).toBe(1);
  });

  it("does not cut the ports while the audio clock is not advancing", async () => {
    // A UA-suspended context in a backgrounded tab (or an OfflineAudioContext
    // between renders): wall-clock time passes, `currentTime` does not, and a
    // plain `setTimeout` teardown would hard-disconnect the ports before the
    // fade had run a single sample.
    const definition = delayDef();
    const mounted = await host().mount({ definition, instanceId: "d1", channelId: "t1" });
    const port = fakeOf(mounted.io.out);

    mounted.dispose();
    for (let i = 0; i < 10; i++) timers.runAll(); // the clock never moves
    expect(port.disconnectCount).toBe(0);

    ctx.currentTime += 1; // context resumes
    timers.runAll();
    expect(port.disconnectCount).toBe(1);
  });

  it("is idempotent, and unmount/dispose cover the same path", async () => {
    const definition = delayDef();
    const h = host();
    const mounted = await h.mount({ definition, instanceId: "d1", channelId: "t1" });
    const disposeSpy = vi.spyOn(mounted.instance, "dispose");
    mounted.dispose();
    mounted.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(h.unmount("d1")).toBe(false);

    const second = await h.mount({ definition, instanceId: "d2", channelId: "t1" });
    expect(h.list()).toEqual([second]);
    expect(h.unmount("d2")).toBe(true);
    expect(h.list()).toEqual([]);
  });

  it("disposes every mounted device when the host goes away", async () => {
    const definition = delayDef();
    const h = host();
    await h.mount({ definition, instanceId: "d1", channelId: "t1" });
    await h.mount({ definition, instanceId: "d2", channelId: "t2" });
    expect(params.list()).toHaveLength(4);

    h.dispose();
    h.dispose();
    expect(h.list()).toEqual([]);
    expect(params.list()).toEqual([]);
  });

  it("satisfies the frozen CreateDeviceHost signature", () => {
    const asContract: CreateDeviceHost = createHost;
    const h = asContract(asContext(ctx), params, devices);
    expect(h.context).toBe(asContext(ctx));
    expect(h.registry).toBe(devices);
    expect(h.get("nothing")).toBeUndefined();
  });
});
