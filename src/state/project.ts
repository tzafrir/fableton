// SS6 + SS8 + SS10 — the v1 document constructors.
//
// `createEmptyProject` is the document every fresh session starts from and
// the fallback `persistence` uses when nothing was autosaved. It is also the
// canonical example of the ./document invariants: one master channel, one
// track holding the default instrument, one empty one-bar clip, 120 bpm, 4/4,
// loop disabled.
//
// Param VALUES live in `Project.paramValues` keyed by full `ParamId` (SS4) —
// never on `DeviceState`. Only the mixer params a fresh document is sure of
// (`vol`/`pan` per channel) are seeded here: a device's params fall back to
// their descriptor defaults when `ParamRegistry.load()` finds no entry, so
// seeding them would mean this package importing the device library just to
// copy numbers that are already the defaults.

import { trackColorAt } from "../ui/theme";
import type {
  Channel,
  ChannelId,
  CreateEmptyProject,
  DeviceInstanceId,
  DeviceState,
  IdFactory,
  MidiClip,
  ParamId,
  Project,
  TimeSignature,
} from "../types";
import { PPQ } from "../types";
import { panParamId, volumeParamId } from "../params";
import { defaultIdFactory } from "./ids";

/** SS8: v1 ships a single fixed-tempo segment. */
export const DEFAULT_BPM = 120;

export const DEFAULT_TIME_SIGNATURE: TimeSignature = { numerator: 4, denominator: 4 };

/** Mixer fader unity, in dB (SS4: real units). */
export const DEFAULT_VOLUME_DB = 0;

/** Mixer pan center (-1..1, SS6). */
export const DEFAULT_PAN = 0;

/** SS18-M0's instrument, and the one a new track gets (SS7 "registered by id"
 *  — this is the id string, not an import of the definition). */
export const DEFAULT_INSTRUMENT_DEFINITION_ID = "core.poly-synth";
export const DEFAULT_INSTRUMENT_VERSION = 1;

export const MASTER_CHANNEL_NAME = "Master";
export const DEFAULT_PROJECT_NAME = "Untitled";

/** One bar of 4/4 at PPQ (SS8): the length of a fresh clip. */
export const ONE_BAR_TICKS = PPQ * 4;

/** Ticks in one bar of the given signature (`4/4` -> 3840, `6/8` -> 2880). */
export function barTicks(signature: TimeSignature): number {
  const numerator = Math.max(1, Math.round(signature.numerator));
  const denominator = Math.max(1, Math.round(signature.denominator));
  return Math.max(1, Math.round((PPQ * 4 * numerator) / denominator));
}

export interface MakeChannelOptions {
  id: ChannelId;
  role: Channel["role"];
  name: string;
  color?: string | null | undefined;
  output: ChannelId | null;
  source?: Channel["source"];
}

/**
 * Builds a `Channel` with its mixer `ParamId`s already wired. `volume`/`pan`
 * are ids, not numbers (SS6 verbatim); their values go into
 * `Project.paramValues`, which is exactly what `ParamRegistry.load()` speaks.
 */
export function makeChannel(options: MakeChannelOptions): Channel {
  return {
    id: options.id,
    role: options.role,
    name: options.name,
    color: options.color ?? null,
    source: options.source ?? null,
    chain: [],
    volume: volumeParamId(options.id),
    pan: panParamId(options.id),
    mute: false,
    solo: false,
    sends: [],
    output: options.output,
  };
}

/** The two mixer param entries a channel contributes to `paramValues`. */
export function defaultMixerParamValues(channelId: ChannelId): Record<ParamId, number> {
  return {
    [volumeParamId(channelId)]: DEFAULT_VOLUME_DB,
    [panParamId(channelId)]: DEFAULT_PAN,
  };
}

export function makeInstrumentDevice(
  deviceId: DeviceInstanceId,
  channelId: ChannelId,
  definitionId: string = DEFAULT_INSTRUMENT_DEFINITION_ID,
  version: number = DEFAULT_INSTRUMENT_VERSION,
): DeviceState {
  return {
    id: deviceId,
    definitionId,
    version,
    channelId,
    enabled: true,
  };
}

/** The id of the document's master channel, or `undefined` in the (invalid)
 *  case of a document without one. */
export function findMasterChannelId(project: {
  channelOrder: readonly ChannelId[];
  channels: Readonly<Record<ChannelId, { role: Channel["role"] }>>;
}): ChannelId | undefined {
  for (const id of project.channelOrder) {
    if (project.channels[id]?.role === "master") return id;
  }
  for (const [id, channel] of Object.entries(project.channels)) {
    if (channel.role === "master") return id;
  }
  return undefined;
}

/**
 * SS13's starting document. Deterministic when handed a deterministic
 * `IdFactory`, which is what makes fixtures and the persistence
 * byte-stability test possible.
 */
export const createEmptyProject: CreateEmptyProject = (options = {}) => {
  const ids: IdFactory = options.ids ?? defaultIdFactory;
  const projectId = options.id ?? ids.project();
  const masterId = ids.channel();
  const trackId = ids.channel();
  const instrumentId = ids.device();
  const clipId = ids.clip();

  const master = makeChannel({
    id: masterId,
    role: "master",
    name: MASTER_CHANNEL_NAME,
    output: null,
  });
  const track = makeChannel({
    id: trackId,
    role: "track",
    name: "Track 1",
    // The first hue off the design system's ribbon, for the same reason
    // `addTrack` assigns one: a track's colour is what the arrangement and
    // the mixer both use to tell parts apart.
    color: trackColorAt(0),
    output: masterId,
    source: { kind: "instrument", deviceId: instrumentId },
  });

  const clip: MidiClip = {
    id: clipId,
    trackId,
    start: 0,
    length: ONE_BAR_TICKS,
    notes: [],
  };

  const project: Project = {
    id: projectId,
    name: options.name ?? DEFAULT_PROJECT_NAME,
    tempo: [{ startTick: 0, bpm: DEFAULT_BPM }],
    timeSignature: { ...DEFAULT_TIME_SIGNATURE },
    loop: { start: 0, end: ONE_BAR_TICKS, enabled: false },
    // Arrangement row order: tracks first, master last (invariant 2 — this
    // array is a permutation of `Object.keys(channels)`).
    channelOrder: [trackId, masterId],
    channels: { [masterId]: master, [trackId]: track },
    devices: { [instrumentId]: makeInstrumentDevice(instrumentId, trackId) },
    clips: { [clipId]: clip },
    lanes: {},
    racks: {},
    sidechains: [],
    assets: {},
    audioClips: {},
    paramValues: {
      ...defaultMixerParamValues(masterId),
      ...defaultMixerParamValues(trackId),
    },
  };
  return project;
};
