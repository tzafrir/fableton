// SS7 — the audio ports the harness owns on a device's behalf.
//
// "Devices connect INTO io.out and read FROM io.in; the harness owns those
// nodes and all wiring outside the device." Every declared port becomes a
// harness-owned `GainNode` at unity: a stable endpoint that exists before the
// device is created and survives it being swapped out (SS7 swap semantics),
// which is what lets the reconciler rewire a chain without touching the DSP.
//
// `{ id: 'sc', optional: true }` in `audioIn` is exactly what makes a device a
// sidechain target (SS6/SS14) — the port node is created like any other, and
// the routing layer connects a source to it later, or never.

import type { DeviceDefinition, DeviceIO, PortSpec } from "../../types";

/** The ports of a definition, without needing the whole definition. */
export type PortDeclarations = Pick<DeviceDefinition, "audioIn" | "audioOut">;

/** Primary port ids (SS7: `io.in` / `io.out` are always present). */
export const PRIMARY_IN = "in";
export const PRIMARY_OUT = "out";

/** A `DeviceIO` plus the harness-side teardown for the nodes it owns. */
export interface DeviceIOBundle {
  readonly io: DeviceIO;
  /** Every port node this bundle created; disconnects all of them. */
  dispose(): void;
}

function assertUniquePorts(ports: readonly PortSpec[], where: string): void {
  const seen = new Set<string>();
  for (const port of ports) {
    if (typeof port.id !== "string" || port.id.length === 0) {
      throw new Error(`DeviceIO: ${where} has a port with an empty id`);
    }
    if (seen.has(port.id)) {
      throw new Error(`DeviceIO: ${where} declares port "${port.id}" twice`);
    }
    seen.add(port.id);
  }
}

function createPortNode(ctx: BaseAudioContext, port: PortSpec): GainNode {
  const node = ctx.createGain();
  node.gain.value = 1;
  // Only force a channel layout when the device actually asked for one:
  // leaving the node's default `max` mode keeps a mono source mono until
  // something downstream decides otherwise.
  if (port.channels !== undefined) {
    node.channelCount = port.channels;
    node.channelCountMode = "explicit";
    node.channelInterpretation = "speakers";
  }
  return node;
}

/**
 * Builds the port nodes for one device instance. Nothing is connected to
 * anything outside the bundle — the caller (the host, then the reconciler)
 * owns that, so a device can be created before it is wired anywhere.
 */
export function createDeviceIO(ctx: BaseAudioContext, def: PortDeclarations): DeviceIOBundle {
  assertUniquePorts(def.audioIn, "audioIn");
  assertUniquePorts(def.audioOut, "audioOut");

  const owned: GainNode[] = [];
  const inputs: Record<string, AudioNode> = {};
  const outputs: Record<string, AudioNode> = {};

  for (const port of def.audioIn) {
    const node = createPortNode(ctx, port);
    owned.push(node);
    inputs[port.id] = node;
  }
  for (const port of def.audioOut) {
    const node = createPortNode(ctx, port);
    owned.push(node);
    outputs[port.id] = node;
  }

  // `io.in` / `io.out` are always present, even for an instrument that
  // declares no input: `create` may reference them unconditionally.
  const primaryIn = inputs[PRIMARY_IN] ?? (def.audioIn[0] ? inputs[def.audioIn[0].id] : undefined);
  const primaryOut =
    outputs[PRIMARY_OUT] ?? (def.audioOut[0] ? outputs[def.audioOut[0].id] : undefined);

  let unattachedIn: GainNode | undefined;
  let unattachedOut: GainNode | undefined;
  if (primaryIn === undefined) {
    unattachedIn = createPortNode(ctx, { id: PRIMARY_IN });
    owned.push(unattachedIn);
  }
  if (primaryOut === undefined) {
    unattachedOut = createPortNode(ctx, { id: PRIMARY_OUT });
    owned.push(unattachedOut);
  }

  const io: DeviceIO = {
    in: primaryIn ?? (unattachedIn as AudioNode),
    out: primaryOut ?? (unattachedOut as AudioNode),
    inputs: Object.freeze({ ...inputs }),
    outputs: Object.freeze({ ...outputs }),
  };

  let disposed = false;
  return {
    io,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const node of owned) node.disconnect();
    },
  };
}
