// Which note is which, for the open clip — the shell's half of SS7's
// `DeviceDefinition.noteNames`.
//
// The piano roll is a generic pitch editor and must stay one (SS9: "each
// editor only supplies its scene and its verbs"); it has no business looking
// up a track's instrument. The device knows what its notes are. The SHELL is
// the only layer allowed to see both, so the join happens here: clip ->
// track -> instrument -> definition -> names, handed to the roll as a plain
// map (SS15's "every input takes a PLAIN object").
//
// Identity matters: `PianoRollView.setPitchNames` re-frames the roll when the
// map changes, and App re-renders on every document change, so a fresh Map
// per render would re-frame the roll on every keystroke. The maps are
// therefore cached per definition — one definition, one map, forever.

import { CORE_DEVICES } from "../devices/core";
import type {
  ClipId,
  DeviceDefinition,
  DeviceDefinitionId,
  PitchNames,
  ProjectSnapshot,
} from "../types";

const definitionsById = new Map<DeviceDefinitionId, DeviceDefinition>(
  CORE_DEVICES.map((def) => [def.id, def]),
);

/** One stable `PitchNames` per definition — see the identity note above. */
const mapsByDefinition = new Map<DeviceDefinitionId, PitchNames | null>();

export function pitchNamesOfDefinition(definitionId: DeviceDefinitionId): PitchNames | null {
  const cached = mapsByDefinition.get(definitionId);
  if (cached !== undefined) return cached;
  const names = definitionsById.get(definitionId)?.noteNames;
  const built =
    names === undefined || names.length === 0
      ? null
      : (new Map(names.map((entry) => [entry.note, entry.label])) as PitchNames);
  mapsByDefinition.set(definitionId, built);
  return built;
}

/**
 * Note names for the instrument the given clip is played through, or `null`
 * when it is played chromatically (or when there is no clip, no track, or no
 * instrument — all of which are ordinary states, not errors).
 */
export function pitchNamesForClip(
  doc: ProjectSnapshot,
  clipId: ClipId | null,
): PitchNames | null {
  if (clipId === null) return null;
  const clip = doc.clips[clipId];
  if (clip === undefined) return null;
  const source = doc.channels[clip.trackId]?.source;
  if (source === undefined || source === null || source.kind !== "instrument") return null;
  const device = doc.devices[source.deviceId];
  if (device === undefined) return null;
  return pitchNamesOfDefinition(device.definitionId);
}
