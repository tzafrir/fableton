// The eight document invariants from types/document.ts, as a checker.
//
// Test-only: `persistence` owns the shipping validator (`ProjectCodec.validate`,
// which also REPAIRS). This one only reports, and exists so every command test
// can end with "and the document is still legal" instead of spot-checking the
// two fields it happened to touch.

import type { Project, ProjectSnapshot } from "../../types";
import { parseParamId } from "../../params";

export function checkProjectInvariants(project: ProjectSnapshot | Project): string[] {
  const problems: string[] = [];
  const fail = (message: string): void => {
    problems.push(message);
  };

  // 1. tempo non-empty, sorted, starts at 0.
  if (project.tempo.length === 0) fail("tempo is empty");
  else {
    if (project.tempo[0]?.startTick !== 0) fail("tempo[0].startTick is not 0");
    for (let i = 1; i < project.tempo.length; i++) {
      const previous = project.tempo[i - 1];
      const segment = project.tempo[i];
      if (previous !== undefined && segment !== undefined && segment.startTick <= previous.startTick) {
        fail(`tempo[${i}] is not after tempo[${i - 1}]`);
      }
    }
  }

  // 2. channelOrder is a permutation of the channel keys.
  const channelKeys = Object.keys(project.channels).sort();
  const ordered = [...project.channelOrder].sort();
  if (channelKeys.length !== ordered.length || channelKeys.some((id, i) => id !== ordered[i])) {
    fail(`channelOrder is not a permutation of channels (${project.channelOrder.length} vs ${channelKeys.length})`);
  }

  // 3. key === value.id everywhere; clip.trackId names a channel.
  for (const [id, channel] of Object.entries(project.channels)) {
    if (channel.id !== id) fail(`channels["${id}"].id is "${channel.id}"`);
  }
  for (const [id, device] of Object.entries(project.devices)) {
    if (device.id !== id) fail(`devices["${id}"].id is "${device.id}"`);
  }
  for (const [id, lane] of Object.entries(project.lanes)) {
    if (lane.id !== id) fail(`lanes["${id}"].id is "${lane.id}"`);
    // SS11: a lane hangs off the channel that owns its target param. A lane
    // whose channel is gone is not "kept and re-bindable" (that promise is
    // about a removed DEVICE's params, SS7) — it is unreachable data the
    // codec drops on the next load, so encode/decode stops being a fixpoint.
    if (project.channels[lane.channelId] === undefined) {
      fail(`lanes["${id}"].channelId "${lane.channelId}" is not a channel`);
    }
  }
  for (const [id, clip] of Object.entries(project.clips)) {
    if (clip.id !== id) fail(`clips["${id}"].id is "${clip.id}"`);
    if (project.channels[clip.trackId] === undefined) {
      fail(`clips["${id}"].trackId "${clip.trackId}" is not a channel`);
    }

    // 4 + 5. notes sorted by (start, pitch), integer ticks, legal ranges.
    let previousStart = -1;
    let previousPitch = -1;
    for (const [index, note] of clip.notes.entries()) {
      const at = `clips["${id}"].notes[${index}]`;
      if (!Number.isInteger(note.start) || note.start < 0) fail(`${at}.start is ${note.start}`);
      if (!Number.isInteger(note.dur) || note.dur < 1) fail(`${at}.dur is ${note.dur}`);
      if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) fail(`${at}.pitch is ${note.pitch}`);
      if (!Number.isInteger(note.vel) || note.vel < 1 || note.vel > 127) fail(`${at}.vel is ${note.vel}`);
      if (note.start < previousStart || (note.start === previousStart && note.pitch < previousPitch)) {
        fail(`${at} breaks the (start, pitch) order`);
      }
      previousStart = note.start;
      previousPitch = note.pitch;
    }
    const noteIds = new Set(clip.notes.map((note) => note.id));
    if (noteIds.size !== clip.notes.length) fail(`clips["${id}"] has duplicate note ids`);
    if (!Number.isInteger(clip.start) || clip.start < 0) fail(`clips["${id}"].start is ${clip.start}`);
    if (!Number.isInteger(clip.length) || clip.length < 1) fail(`clips["${id}"].length is ${clip.length}`);
  }

  // 6. paramValues are finite numbers whose owning channel exists.
  for (const [paramId, value] of Object.entries(project.paramValues)) {
    if (!Number.isFinite(value)) fail(`paramValues["${paramId}"] is ${String(value)}`);
    const parsed = parseParamId(paramId);
    if (parsed === null) {
      fail(`paramValues["${paramId}"] is not a well-formed ParamId`);
      continue;
    }
    if (project.channels[parsed.channelId] === undefined) {
      fail(`paramValues["${paramId}"] names channel "${parsed.channelId}", which does not exist`);
    }
    if (parsed.kind === "device" && project.devices[parsed.instanceId] === undefined) {
      fail(`paramValues["${paramId}"] names device "${parsed.instanceId}", which does not exist`);
    }
  }

  // 7. devices[id].channelId agrees with the channel that hosts it.
  const hosts = new Map<string, string>();
  for (const channel of Object.values(project.channels)) {
    if (channel.source !== null) hosts.set(channel.source.deviceId, channel.id);
    for (const deviceId of channel.chain) hosts.set(deviceId, channel.id);
    if (channel.output !== null && project.channels[channel.output] === undefined) {
      fail(`channels["${channel.id}"].output "${channel.output}" does not exist`);
    }
    for (const send of channel.sends) {
      if (project.channels[send.to] === undefined) {
        fail(`channels["${channel.id}"] sends to "${send.to}", which does not exist`);
      }
    }
  }
  for (const [id, device] of Object.entries(project.devices)) {
    const host = hosts.get(id);
    if (host === undefined) fail(`devices["${id}"] is not referenced by any channel`);
    else if (host !== device.channelId) fail(`devices["${id}"].channelId is "${device.channelId}" but it lives on "${host}"`);
  }

  // 8. no key holds `undefined` (a JSON round-trip would drop it).
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) fail(`${path}.${key} is undefined`);
      else walk(member, `${path}.${key}`);
    }
  };
  walk(project, "project");

  // Sidechain edges point at things that exist.
  for (const [index, edge] of project.sidechains.entries()) {
    if (project.channels[edge.from.channel] === undefined) {
      fail(`sidechains[${index}].from.channel "${edge.from.channel}" does not exist`);
    }
    if (project.devices[edge.to.device] === undefined) {
      fail(`sidechains[${index}].to.device "${edge.to.device}" does not exist`);
    }
  }

  return problems;
}

/** Throws with every problem listed. Use at the end of a command test. */
export function expectLegalProject(project: ProjectSnapshot | Project): void {
  const problems = checkProjectInvariants(project);
  if (problems.length > 0) {
    throw new Error(`document invariants broken:\n  - ${problems.join("\n  - ")}`);
  }
}
