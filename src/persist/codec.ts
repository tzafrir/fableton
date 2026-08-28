// SS2 + SS13 — the single JSON boundary (`ProjectCodec`).
//
// `encode` is deterministic: a fixed key order (the declaration order in
// ../types/document, and for id-keyed records the order of `channelOrder`
// or lexicographic id order where there is none) and no `undefined`-valued
// keys, ever. That determinism is what makes SS2's "open -> edit -> save ->
// reopen byte-stable except for edits" testable — see ./roundTrip.test.ts.
//
// `decode`/`decodeValue` are the defensive direction: untrusted JSON in,
// warnings out. Nothing here throws on malformed input; a structurally
// unrecoverable file becomes `{ ok: false }`, and a recoverable one becomes
// `{ ok: true, warnings: [...] }` with the offending bits clamped, defaulted
// or dropped by `validate` (document.ts invariants 1-8).

import { findRoutingCycle, sidechainIsFeedForward } from "../engine/graph/validate";
import { rackChainParamId } from "../params/paramIds";
import type {
  AudioAsset,
  AudioClip,
  AutomationLane,
  AutoPoint,
  Channel,
  ChannelRole,
  DecodeResult,
  DeviceState,
  EncodeOptions,
  JsonValue,
  LoadWarning,
  LoopRegion,
  MidiClip,
  Note,
  Project,
  ProjectCodec,
  ProjectFile,
  RackChain,
  RackMacro,
  RackState,
  SendSpec,
  SidechainEdge,
  SourceRef,
  TempoSegment,
  TimeSignature,
} from "../types";
import { PROJECT_SCHEMA_VERSION } from "../types";
import { runMigrations } from "./migrations";

const FORMAT_MARKER: ProjectFile["format"] = "fableton.project";
const NOT_A_PROJECT_FILE = "Not a Fableton project file.";

// -----------------------------------------------------------------------
// encode
// -----------------------------------------------------------------------

function canonicalTempoSegment(s: TempoSegment): JsonValue {
  return { startTick: s.startTick, bpm: s.bpm };
}

function canonicalTimeSignature(t: TimeSignature): JsonValue {
  return { numerator: t.numerator, denominator: t.denominator };
}

function canonicalLoop(l: LoopRegion): JsonValue {
  return { start: l.start, end: l.end, enabled: l.enabled };
}

function canonicalSourceRef(s: SourceRef): JsonValue {
  return { kind: s.kind, deviceId: s.deviceId };
}

function canonicalSendSpec(s: SendSpec): JsonValue {
  return { to: s.to, amount: s.amount, tap: s.tap };
}

function canonicalChannel(c: Channel): JsonValue {
  const out: Record<string, JsonValue> = {
    id: c.id,
    role: c.role,
    name: c.name,
    color: c.color,
    source: c.source === null ? null : canonicalSourceRef(c.source),
    chain: [...c.chain],
    volume: c.volume,
    pan: c.pan,
    mute: c.mute,
    solo: c.solo,
    sends: c.sends.map(canonicalSendSpec),
    output: c.output,
  };
  // Omitted entirely when empty, exactly like `DeviceState.settings`: a
  // project with no note effects encodes as it did before they existed.
  if (c.midiChain !== undefined && c.midiChain.length > 0) {
    out["midiChain"] = [...c.midiChain];
  }
  return out;
}

function canonicalDeviceState(d: DeviceState): JsonValue {
  const out: Record<string, JsonValue> = {
    id: d.id,
    definitionId: d.definitionId,
    version: d.version,
    channelId: d.channelId,
    enabled: d.enabled,
  };
  // Omitted entirely when empty, so a device with no settings encodes exactly
  // as it did before settings existed — byte-stability (SS2) across the
  // addition, and nothing to diff in an old project's file.
  const keys = Object.keys(d.settings ?? {}).sort();
  if (keys.length > 0) {
    const settings: Record<string, JsonValue> = {};
    for (const key of keys) settings[key] = d.settings?.[key] ?? "";
    out["settings"] = settings;
  }
  return out;
}

function canonicalAsset(a: AudioAsset): JsonValue {
  const out: Record<string, JsonValue> = {
    id: a.id,
    name: a.name,
    sampleRate: a.sampleRate,
    channels: a.channels,
    frames: a.frames,
  };
  // Rounded to three places on the way out: the waveform is drawn a few
  // hundred pixels wide, so full float precision is bytes spent on a
  // difference no eye and no test can see.
  if (a.peaks !== undefined && a.peaks.length > 0) {
    out["peaks"] = a.peaks.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000);
  }
  return out;
}

function canonicalAudioClip(c: AudioClip): JsonValue {
  const out: Record<string, JsonValue> = {
    kind: "audio",
    id: c.id,
    trackId: c.trackId,
    start: c.start,
    length: c.length,
    assetId: c.assetId,
    offsetFrames: c.offsetFrames,
    gainDb: c.gainDb,
  };
  if (c.name !== undefined) out["name"] = c.name;
  if (c.color !== undefined && c.color !== null) out["color"] = c.color;
  return out;
}

/** Document invariant 4: `clip.notes` stays sorted by `(start, pitch)`. The
 *  command layer is what is supposed to maintain that, but encode sorts
 *  again anyway — cheap, and it is what makes `encode` deterministic (and
 *  thus SS2's byte-stability) independent of whatever order a caller's
 *  notes array happens to be in. */
function compareNotesForEncode(a: Note, b: Note): number {
  return a.start - b.start || a.pitch - b.pitch;
}

function canonicalNote(n: Note): JsonValue {
  const out: { [key: string]: JsonValue } = {
    id: n.id,
    start: n.start,
    dur: n.dur,
    pitch: n.pitch,
    vel: n.vel,
  };
  if (n.muted !== undefined) out["muted"] = n.muted;
  return out;
}

function canonicalClip(c: MidiClip): JsonValue {
  const out: { [key: string]: JsonValue } = {
    id: c.id,
    trackId: c.trackId,
    start: c.start,
    length: c.length,
  };
  if (c.loop !== undefined) out["loop"] = { start: c.loop.start, end: c.loop.end };
  out["notes"] = [...c.notes].sort(compareNotesForEncode).map(canonicalNote);
  if (c.name !== undefined) out["name"] = c.name;
  if (c.color !== undefined) out["color"] = c.color;
  return out;
}

function canonicalAutoPoint(p: AutoPoint): JsonValue {
  return { t: p.t, v: p.v, curve: p.curve };
}

function canonicalAutomationLane(l: AutomationLane): JsonValue {
  return {
    id: l.id,
    channelId: l.channelId,
    paramId: l.paramId,
    points: l.points.map(canonicalAutoPoint),
    enabled: l.enabled,
  };
}

function canonicalRackChain(c: RackChain): JsonValue {
  return {
    id: c.id,
    name: c.name,
    devices: [...c.devices],
    mute: c.mute,
    solo: c.solo,
    gain: c.gain,
    pan: c.pan,
  };
}

function canonicalRackMacro(m: RackMacro): JsonValue {
  return {
    id: m.id,
    name: m.name,
    param: m.param,
    targets: m.targets.map((t) => ({ paramId: t.paramId, min: t.min, max: t.max })),
  };
}

function canonicalRack(r: RackState): JsonValue {
  return {
    id: r.id,
    channelId: r.channelId,
    name: r.name,
    enabled: r.enabled,
    // Chain and macro ORDER is meaningful (it is the on-screen order), so
    // these stay arrays and are never sorted, unlike the keyed records.
    chains: r.chains.map(canonicalRackChain),
    macros: r.macros.map(canonicalRackMacro),
  };
}

function canonicalSidechainEdge(s: SidechainEdge): JsonValue {
  return {
    from: { channel: s.from.channel, tap: s.from.tap },
    to: { device: s.to.device, port: s.to.port },
  };
}

/** Id-keyed record -> plain object with keys written in `order`. Ids not
 *  present in `order` are dropped silently (encode assumes a valid
 *  `Project`; `validate` is what repairs an invalid one before this runs). */
function canonicalRecord<T>(
  record: Readonly<Record<string, T>>,
  order: readonly string[],
  toJson: (value: T) => JsonValue,
): JsonValue {
  const out: { [key: string]: JsonValue } = {};
  for (const key of order) {
    const value = record[key];
    if (value !== undefined) out[key] = toJson(value);
  }
  return out;
}

function lexicographicOrder(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort();
}

/** `channelOrder` ids that exist in `channels`, then any orphaned channel
 *  ids (should not happen in a valid document) appended lexicographically so
 *  encode never silently drops data. */
function channelWriteOrder(project: Project): string[] {
  const known = new Set(Object.keys(project.channels));
  const ordered = project.channelOrder.filter((id) => known.has(id));
  const orderedSet = new Set(ordered);
  const orphaned = Object.keys(project.channels)
    .filter((id) => !orderedSet.has(id))
    .sort();
  return [...ordered, ...orphaned];
}

function canonicalParamValues(values: Readonly<Record<string, number>>): JsonValue {
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(values).sort()) {
    const v = values[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function canonicalProject(p: Project): JsonValue {
  return {
    id: p.id,
    name: p.name,
    tempo: p.tempo.map(canonicalTempoSegment),
    timeSignature: canonicalTimeSignature(p.timeSignature),
    loop: canonicalLoop(p.loop),
    channelOrder: [...p.channelOrder],
    channels: canonicalRecord(p.channels, channelWriteOrder(p), canonicalChannel),
    devices: canonicalRecord(p.devices, lexicographicOrder(p.devices), canonicalDeviceState),
    clips: canonicalRecord(p.clips, lexicographicOrder(p.clips), canonicalClip),
    lanes: canonicalRecord(p.lanes, lexicographicOrder(p.lanes), canonicalAutomationLane),
    racks: canonicalRecord(p.racks, lexicographicOrder(p.racks), canonicalRack),
    sidechains: p.sidechains.map(canonicalSidechainEdge),
    assets: canonicalRecord(p.assets, lexicographicOrder(p.assets), canonicalAsset),
    audioClips: canonicalRecord(
      p.audioClips,
      lexicographicOrder(p.audioClips),
      canonicalAudioClip,
    ),
    paramValues: canonicalParamValues(p.paramValues),
  };
}

function encode(project: Project, options?: EncodeOptions): string {
  const savedAt = options?.savedAt ?? new Date().toISOString();
  const file: { [key: string]: JsonValue } = {
    format: FORMAT_MARKER,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    savedAt,
    project: canonicalProject(project),
  };
  const pretty = options?.pretty ?? true;
  return pretty ? JSON.stringify(file, null, 2) : JSON.stringify(file);
}

// -----------------------------------------------------------------------
// decode — defensive JsonValue -> Project
// -----------------------------------------------------------------------

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushWarning(warnings: LoadWarning[], path: string, message: string): void {
  warnings.push({ path, message });
}

function asObject(
  value: JsonValue | undefined,
  path: string,
  warnings: LoadWarning[],
): { [key: string]: JsonValue } {
  if (value !== undefined && isJsonObject(value)) return value;
  if (value !== undefined) pushWarning(warnings, path, "Expected an object; using an empty one.");
  return {};
}

function asArray(value: JsonValue | undefined, path: string, warnings: LoadWarning[]): JsonValue[] {
  if (Array.isArray(value)) return value;
  if (value !== undefined) pushWarning(warnings, path, "Expected an array; using an empty one.");
  return [];
}

function asString(
  value: JsonValue | undefined,
  path: string,
  fallback: string,
  warnings: LoadWarning[],
): string {
  if (typeof value === "string") return value;
  pushWarning(warnings, path, `Expected a string; defaulted to ${JSON.stringify(fallback)}.`);
  return fallback;
}

function asFiniteNumber(
  value: JsonValue | undefined,
  path: string,
  fallback: number,
  warnings: LoadWarning[],
): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  pushWarning(warnings, path, `Expected a finite number; defaulted to ${fallback}.`);
  return fallback;
}

function asBoolean(
  value: JsonValue | undefined,
  path: string,
  fallback: boolean,
  warnings: LoadWarning[],
): boolean {
  if (typeof value === "boolean") return value;
  pushWarning(warnings, path, `Expected a boolean; defaulted to ${fallback}.`);
  return fallback;
}

function asNullableString(
  value: JsonValue | undefined,
  path: string,
  warnings: LoadWarning[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  pushWarning(warnings, path, "Expected a string or null; defaulted to null.");
  return null;
}

let fallbackCounter = 0;
/** Only used to fill a structurally-required id the source JSON lacks
 *  entirely (e.g. a note object with no `id` field at all). Distinct from
 *  the `IdFactory` commands use — this is a load-time repair, not a
 *  document edit. */
function fallbackId(prefix: string): string {
  fallbackCounter += 1;
  return `${prefix}-recovered-${fallbackCounter}`;
}

function parseTempo(raw: JsonValue | undefined, path: string, warnings: LoadWarning[]): TempoSegment[] {
  const arr = asArray(raw, path, warnings);
  return arr.map((item, i) => {
    const obj = asObject(item, `${path}[${i}]`, warnings);
    return {
      startTick: Math.round(asFiniteNumber(obj["startTick"], `${path}[${i}].startTick`, 0, warnings)),
      bpm: asFiniteNumber(obj["bpm"], `${path}[${i}].bpm`, 120, warnings),
    };
  });
}

function parseTimeSignature(raw: JsonValue | undefined, path: string, warnings: LoadWarning[]): TimeSignature {
  const obj = asObject(raw, path, warnings);
  return {
    numerator: asFiniteNumber(obj["numerator"], `${path}.numerator`, 4, warnings),
    denominator: asFiniteNumber(obj["denominator"], `${path}.denominator`, 4, warnings),
  };
}

function parseLoop(raw: JsonValue | undefined, path: string, warnings: LoadWarning[]): LoopRegion {
  const obj = asObject(raw, path, warnings);
  return {
    start: Math.round(asFiniteNumber(obj["start"], `${path}.start`, 0, warnings)),
    end: Math.round(asFiniteNumber(obj["end"], `${path}.end`, 0, warnings)),
    enabled: asBoolean(obj["enabled"], `${path}.enabled`, false, warnings),
  };
}

function parseSourceRef(
  raw: JsonValue | undefined,
  path: string,
  warnings: LoadWarning[],
): SourceRef | null {
  if (raw === undefined || raw === null) return null;
  const obj = asObject(raw, path, warnings);
  if (obj["kind"] !== "instrument") {
    pushWarning(warnings, `${path}.kind`, "Unknown source kind; dropped.");
    return null;
  }
  return { kind: "instrument", deviceId: asString(obj["deviceId"], `${path}.deviceId`, "", warnings) };
}

function parseSendSpec(raw: JsonValue, path: string, warnings: LoadWarning[]): SendSpec {
  const obj = asObject(raw, path, warnings);
  const tapRaw = obj["tap"];
  const tap: SendSpec["tap"] = tapRaw === "post" ? "post" : "pre";
  if (tapRaw !== "pre" && tapRaw !== "post") {
    pushWarning(warnings, `${path}.tap`, 'Expected "pre" or "post"; defaulted to "pre".');
  }
  return {
    to: asString(obj["to"], `${path}.to`, "", warnings),
    amount: asString(obj["amount"], `${path}.amount`, "", warnings),
    tap,
  };
}

const CHANNEL_ROLES: readonly ChannelRole[] = ["track", "group", "return", "master"];

function parseChannel(raw: JsonValue, key: string, path: string, warnings: LoadWarning[]): Channel {
  const obj = asObject(raw, path, warnings);
  const roleRaw = obj["role"];
  const role: ChannelRole = (CHANNEL_ROLES as readonly string[]).includes(roleRaw as string)
    ? (roleRaw as ChannelRole)
    : "track";
  if (role !== roleRaw) pushWarning(warnings, `${path}.role`, 'Unknown role; defaulted to "track".');

  const idRaw = obj["id"];
  if (typeof idRaw === "string" && idRaw !== key) {
    pushWarning(warnings, `${path}.id`, "id did not match its record key; record key wins.");
  }

  const chain = asArray(obj["chain"], `${path}.chain`, warnings).filter(
    (v): v is string => typeof v === "string",
  );
  // Absent is the common case and not a defect, so it is read without a
  // warning; an empty list decodes back to "absent" for the same reason it
  // encodes to nothing.
  const midiChainRaw =
    obj["midiChain"] === undefined
      ? []
      : asArray(obj["midiChain"], `${path}.midiChain`, warnings).filter(
          (v): v is string => typeof v === "string",
        );

  const output = obj["output"] === null ? null : asString(obj["output"], `${path}.output`, "", warnings) || null;

  return {
    id: key,
    role,
    name: asString(obj["name"], `${path}.name`, "", warnings),
    color: asNullableString(obj["color"], `${path}.color`, warnings),
    source: parseSourceRef(obj["source"], `${path}.source`, warnings),
    chain,
    ...(midiChainRaw.length > 0 ? { midiChain: midiChainRaw } : {}),
    volume: asString(obj["volume"], `${path}.volume`, `chan:${key}/vol`, warnings),
    pan: asString(obj["pan"], `${path}.pan`, `chan:${key}/pan`, warnings),
    mute: asBoolean(obj["mute"], `${path}.mute`, false, warnings),
    solo: asBoolean(obj["solo"], `${path}.solo`, false, warnings),
    sends: asArray(obj["sends"], `${path}.sends`, warnings).map((v, i) =>
      parseSendSpec(v, `${path}.sends[${i}]`, warnings),
    ),
    output,
  };
}

function parseDeviceState(raw: JsonValue, key: string, path: string, warnings: LoadWarning[]): DeviceState {
  const obj = asObject(raw, path, warnings);
  return {
    id: key,
    definitionId: asString(obj["definitionId"], `${path}.definitionId`, "", warnings),
    version: Math.round(asFiniteNumber(obj["version"], `${path}.version`, 1, warnings)),
    channelId: asString(obj["channelId"], `${path}.channelId`, "", warnings),
    enabled: asBoolean(obj["enabled"], `${path}.enabled`, true, warnings),
    ...parseDeviceSettings(obj["settings"], `${path}.settings`, warnings),
  };
}

/** Device settings are strings by contract; anything else in the file is
 *  dropped with a warning rather than smuggled through as a number. */
function parseDeviceSettings(
  raw: JsonValue | undefined,
  path: string,
  warnings: LoadWarning[],
): { settings?: Record<string, string> } {
  if (raw === undefined || raw === null) return {};
  const obj = asObject(raw, path, warnings);
  const settings: Record<string, string> = {};
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    if (typeof value === "string") settings[key] = value;
    else pushWarning(warnings, `${path}.${key}`, "Setting is not a string; dropped.");
  }
  return Object.keys(settings).length === 0 ? {} : { settings };
}

function parseAsset(raw: JsonValue, key: string, path: string, warnings: LoadWarning[]): AudioAsset {
  const obj = asObject(raw, path, warnings);
  return {
    id: key,
    name: asString(obj["name"], `${path}.name`, key, warnings),
    sampleRate: Math.max(
      1,
      Math.round(asFiniteNumber(obj["sampleRate"], `${path}.sampleRate`, 48000, warnings)),
    ),
    channels: Math.max(
      1,
      Math.round(asFiniteNumber(obj["channels"], `${path}.channels`, 1, warnings)),
    ),
    frames: Math.max(0, Math.round(asFiniteNumber(obj["frames"], `${path}.frames`, 0, warnings))),
    ...parsePeaks(obj["peaks"], `${path}.peaks`, warnings),
  };
}

function parsePeaks(
  raw: JsonValue | undefined,
  path: string,
  warnings: LoadWarning[],
): { peaks?: number[] } {
  if (raw === undefined || raw === null) return {};
  const values = asArray(raw, path, warnings).map((v, i) =>
    Math.min(1, Math.max(0, asFiniteNumber(v, `${path}[${String(i)}]`, 0, warnings))),
  );
  return values.length === 0 ? {} : { peaks: values };
}

function parseAudioClip(
  raw: JsonValue,
  key: string,
  path: string,
  warnings: LoadWarning[],
): AudioClip {
  const obj = asObject(raw, path, warnings);
  const out: AudioClip = {
    kind: "audio",
    id: key,
    trackId: asString(obj["trackId"], `${path}.trackId`, "", warnings),
    start: Math.max(0, Math.round(asFiniteNumber(obj["start"], `${path}.start`, 0, warnings))),
    length: Math.max(
      1,
      Math.round(asFiniteNumber(obj["length"], `${path}.length`, 1, warnings)),
    ),
    assetId: asString(obj["assetId"], `${path}.assetId`, "", warnings),
    offsetFrames: Math.max(
      0,
      Math.round(asFiniteNumber(obj["offsetFrames"], `${path}.offsetFrames`, 0, warnings)),
    ),
    gainDb: asFiniteNumber(obj["gainDb"], `${path}.gainDb`, 0, warnings),
  };
  if (typeof obj["name"] === "string") out.name = obj["name"];
  if (typeof obj["color"] === "string") out.color = obj["color"];
  return out;
}

function parseNote(raw: JsonValue, path: string, warnings: LoadWarning[]): Note {
  const obj = asObject(raw, path, warnings);
  const id = typeof obj["id"] === "string" ? obj["id"] : fallbackId("note");
  if (typeof obj["id"] !== "string") pushWarning(warnings, `${path}.id`, "Missing id; a new one was generated.");
  const out: Note = {
    id,
    start: Math.max(0, Math.round(asFiniteNumber(obj["start"], `${path}.start`, 0, warnings))),
    dur: Math.max(1, Math.round(asFiniteNumber(obj["dur"], `${path}.dur`, 1, warnings))),
    pitch: clampInt(asFiniteNumber(obj["pitch"], `${path}.pitch`, 60, warnings), 0, 127),
    vel: clampInt(asFiniteNumber(obj["vel"], `${path}.vel`, 100, warnings), 1, 127),
  };
  if (typeof obj["muted"] === "boolean") out.muted = obj["muted"];
  return out;
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}

function parseClip(raw: JsonValue, key: string, path: string, warnings: LoadWarning[]): MidiClip {
  const obj = asObject(raw, path, warnings);
  const clip: MidiClip = {
    id: key,
    trackId: asString(obj["trackId"], `${path}.trackId`, "", warnings),
    start: Math.max(0, Math.round(asFiniteNumber(obj["start"], `${path}.start`, 0, warnings))),
    length: Math.max(1, Math.round(asFiniteNumber(obj["length"], `${path}.length`, 1, warnings))),
    notes: asArray(obj["notes"], `${path}.notes`, warnings).map((v, i) =>
      parseNote(v, `${path}.notes[${i}]`, warnings),
    ),
  };
  const loopRaw = obj["loop"];
  if (loopRaw !== undefined && loopRaw !== null) {
    const loopObj = asObject(loopRaw, `${path}.loop`, warnings);
    clip.loop = {
      start: Math.round(asFiniteNumber(loopObj["start"], `${path}.loop.start`, 0, warnings)),
      end: Math.round(asFiniteNumber(loopObj["end"], `${path}.loop.end`, clip.length, warnings)),
    };
  }
  if (typeof obj["name"] === "string") clip.name = obj["name"];
  const colorRaw = obj["color"];
  if (colorRaw === null) clip.color = null;
  else if (typeof colorRaw === "string") clip.color = colorRaw;
  return clip;
}

function parseAutoPoint(raw: JsonValue, path: string, warnings: LoadWarning[]): AutoPoint {
  const obj = asObject(raw, path, warnings);
  return {
    t: Math.round(asFiniteNumber(obj["t"], `${path}.t`, 0, warnings)),
    v: asFiniteNumber(obj["v"], `${path}.v`, 0, warnings),
    curve: Math.min(1, Math.max(-1, asFiniteNumber(obj["curve"], `${path}.curve`, 0, warnings))),
  };
}

function parseAutomationLane(
  raw: JsonValue,
  key: string,
  path: string,
  warnings: LoadWarning[],
): AutomationLane {
  const obj = asObject(raw, path, warnings);
  const points = asArray(obj["points"], `${path}.points`, warnings)
    .map((v, i) => parseAutoPoint(v, `${path}.points[${i}]`, warnings))
    .sort((a, b) => a.t - b.t);
  return {
    id: key,
    channelId: asString(obj["channelId"], `${path}.channelId`, "", warnings),
    paramId: asString(obj["paramId"], `${path}.paramId`, "", warnings),
    points,
    enabled: asBoolean(obj["enabled"], `${path}.enabled`, true, warnings),
  };
}

function parseRackChain(raw: JsonValue, path: string, warnings: LoadWarning[]): RackChain {
  const obj = asObject(raw, path, warnings);
  const id = asString(obj["id"], `${path}.id`, fallbackId("rchain"), warnings);
  return {
    id,
    name: asString(obj["name"], `${path}.name`, "Chain", warnings),
    devices: asArray(obj["devices"], `${path}.devices`, warnings).filter(
      (v): v is string => typeof v === "string",
    ),
    mute: asBoolean(obj["mute"], `${path}.mute`, false, warnings),
    solo: asBoolean(obj["solo"], `${path}.solo`, false, warnings),
    gain: asString(obj["gain"], `${path}.gain`, "", warnings),
    pan: asString(obj["pan"], `${path}.pan`, "", warnings),
  };
}

function parseRackMacro(raw: JsonValue, path: string, warnings: LoadWarning[]): RackMacro {
  const obj = asObject(raw, path, warnings);
  return {
    id: asString(obj["id"], `${path}.id`, fallbackId("macro"), warnings),
    name: asString(obj["name"], `${path}.name`, "Macro", warnings),
    param: asString(obj["param"], `${path}.param`, "", warnings),
    targets: asArray(obj["targets"], `${path}.targets`, warnings).map((t, i) => {
      const to = asObject(t, `${path}.targets[${i}]`, warnings);
      return {
        paramId: asString(to["paramId"], `${path}.targets[${i}].paramId`, "", warnings),
        min: asFiniteNumber(to["min"], `${path}.targets[${i}].min`, 0, warnings),
        max: asFiniteNumber(to["max"], `${path}.targets[${i}].max`, 1, warnings),
      };
    }),
  };
}

function parseRack(raw: JsonValue, key: string, path: string, warnings: LoadWarning[]): RackState {
  const obj = asObject(raw, path, warnings);
  return {
    id: key,
    channelId: asString(obj["channelId"], `${path}.channelId`, "", warnings),
    name: asString(obj["name"], `${path}.name`, "Rack", warnings),
    enabled: asBoolean(obj["enabled"], `${path}.enabled`, true, warnings),
    chains: asArray(obj["chains"], `${path}.chains`, warnings).map((v, i) =>
      parseRackChain(v, `${path}.chains[${i}]`, warnings),
    ),
    macros: asArray(obj["macros"], `${path}.macros`, warnings).map((v, i) =>
      parseRackMacro(v, `${path}.macros[${i}]`, warnings),
    ),
  };
}

const SIDECHAIN_TAPS: readonly SidechainEdge["from"]["tap"][] = ["preFx", "postFx", "postFader"];

function parseSidechainEdge(raw: JsonValue, path: string, warnings: LoadWarning[]): SidechainEdge {
  const obj = asObject(raw, path, warnings);
  const fromObj = asObject(obj["from"], `${path}.from`, warnings);
  const toObj = asObject(obj["to"], `${path}.to`, warnings);
  const tapRaw = fromObj["tap"];
  const tap: SidechainEdge["from"]["tap"] = (SIDECHAIN_TAPS as readonly string[]).includes(
    tapRaw as string,
  )
    ? (tapRaw as SidechainEdge["from"]["tap"])
    : "postFx";
  if (tap !== tapRaw) pushWarning(warnings, `${path}.from.tap`, 'Unknown tap; defaulted to "postFx".');
  return {
    from: { channel: asString(fromObj["channel"], `${path}.from.channel`, "", warnings), tap },
    to: { device: asString(toObj["device"], `${path}.to.device`, "", warnings), port: "sc" },
  };
}

function parseParamValues(
  raw: JsonValue | undefined,
  path: string,
  warnings: LoadWarning[],
): Record<string, number> {
  const obj = asObject(raw, path, warnings);
  const out: Record<string, number> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else pushWarning(warnings, `${path}.${key}`, "Expected a finite number; entry dropped.");
  }
  return out;
}

type ParseOutcome = { readonly project: Project } | { readonly error: string };

function parseProject(raw: JsonValue, warnings: LoadWarning[]): ParseOutcome {
  if (!isJsonObject(raw)) return { error: NOT_A_PROJECT_FILE };

  const idRaw = raw["id"];
  const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : fallbackId("project");
  if (id !== idRaw) pushWarning(warnings, "id", "Missing or invalid project id; a new one was generated.");

  const name = asString(raw["name"], "name", "Untitled", warnings);

  const tempoParsed = parseTempo(raw["tempo"], "tempo", warnings);
  const tempo: TempoSegment[] = tempoParsed.length > 0 ? tempoParsed : [{ startTick: 0, bpm: 120 }];

  const timeSignature = parseTimeSignature(raw["timeSignature"], "timeSignature", warnings);
  const loop = parseLoop(raw["loop"], "loop", warnings);

  const channelsObj = asObject(raw["channels"], "channels", warnings);
  const channels: Record<string, Channel> = {};
  for (const key of Object.keys(channelsObj)) {
    const value = channelsObj[key];
    if (value !== undefined) channels[key] = parseChannel(value, key, `channels.${key}`, warnings);
  }

  const channelOrder = asArray(raw["channelOrder"], "channelOrder", warnings).filter(
    (v): v is string => typeof v === "string",
  );

  const devicesObj = asObject(raw["devices"], "devices", warnings);
  const devices: Record<string, DeviceState> = {};
  for (const key of Object.keys(devicesObj)) {
    const value = devicesObj[key];
    if (value !== undefined) devices[key] = parseDeviceState(value, key, `devices.${key}`, warnings);
  }

  const clipsObj = asObject(raw["clips"], "clips", warnings);
  const clips: Record<string, MidiClip> = {};
  for (const key of Object.keys(clipsObj)) {
    const value = clipsObj[key];
    if (value !== undefined) clips[key] = parseClip(value, key, `clips.${key}`, warnings);
  }

  const lanesObj = asObject(raw["lanes"], "lanes", warnings);
  const lanes: Record<string, AutomationLane> = {};
  for (const key of Object.keys(lanesObj)) {
    const value = lanesObj[key];
    if (value !== undefined) lanes[key] = parseAutomationLane(value, key, `lanes.${key}`, warnings);
  }

  // Racks are ADDITIVE: a v1 file written before they existed simply has no
  // `racks` key, and `asObject` turns that into `{}` with no warning.
  const racksObj = asObject(raw["racks"], "racks", warnings);
  const racks: Record<string, RackState> = {};
  for (const key of Object.keys(racksObj)) {
    const value = racksObj[key];
    if (value !== undefined) racks[key] = parseRack(value, key, `racks.${key}`, warnings);
  }

  const sidechains = asArray(raw["sidechains"], "sidechains", warnings).map((v, i) =>
    parseSidechainEdge(v, `sidechains[${i}]`, warnings),
  );

  // Assets are ADDITIVE, like racks: a file written before they existed has
  // no `assets` key and decodes to `{}`. That totality is why this needed no
  // schema bump — see PROJECT_SCHEMA_VERSION.
  const assetsObj = asObject(raw["assets"], "assets", warnings);
  const assets: Record<string, AudioAsset> = {};
  for (const key of Object.keys(assetsObj)) {
    const value = assetsObj[key];
    if (value !== undefined) assets[key] = parseAsset(value, key, `assets.${key}`, warnings);
  }

  const audioClipsObj = asObject(raw["audioClips"], "audioClips", warnings);
  const audioClips: Record<string, AudioClip> = {};
  for (const key of Object.keys(audioClipsObj)) {
    const value = audioClipsObj[key];
    if (value !== undefined) {
      audioClips[key] = parseAudioClip(value, key, `audioClips.${key}`, warnings);
    }
  }

  const paramValues = parseParamValues(raw["paramValues"], "paramValues", warnings);

  const project: Project = {
    id,
    name,
    tempo,
    timeSignature,
    loop,
    channelOrder,
    channels,
    devices,
    clips,
    lanes,
    racks,
    sidechains,
    assets,
    audioClips,
    paramValues,
  };
  return { project };
}

// -----------------------------------------------------------------------
// validate — document.ts invariants 1-8, repaired in place
// -----------------------------------------------------------------------

function compareNotes(a: Note, b: Note): number {
  return a.start - b.start || a.pitch - b.pitch;
}

function notesAlreadySorted(notes: readonly Note[]): boolean {
  for (let i = 1; i < notes.length; i++) {
    const prev = notes[i - 1];
    const cur = notes[i];
    if (prev === undefined || cur === undefined) continue;
    if (compareNotes(prev, cur) > 0) return false;
  }
  return true;
}

/**
 * Validates + repairs document.ts invariants 1-5 in place (8 is structural
 * — the parser above never produces an `undefined`-valued key — and 6/7
 * name devices/params this package has no registry to check against, so
 * they are left to the app-shell's own consistency pass). Returns one
 * warning per repair made.
 */
function validateProject(project: Project): LoadWarning[] {
  const warnings: LoadWarning[] = [];

  // Invariant 1: tempo non-empty, sorted, starts at 0.
  const tempoOk =
    project.tempo.length > 0 &&
    project.tempo[0]?.startTick === 0 &&
    project.tempo.every((seg, i) => i === 0 || (project.tempo[i - 1]?.startTick ?? 0) <= seg.startTick);
  if (!tempoOk) {
    const bpm = project.tempo[0]?.bpm ?? 120;
    project.tempo = [{ startTick: 0, bpm }];
    pushWarning(warnings, "tempo", "Tempo map was invalid; reset to a single 120 bpm segment.");
  }

  // Invariant 2: channelOrder is a PERMUTATION of Object.keys(channels) —
  // no strangers, no gaps, and no duplicates. The duplicate half matters as
  // much as the others: every later pass here walks `channelOrder`, so a
  // doubled id is a channel visited twice, and the master pass below would
  // then see the project's only master a second time and demote it.
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const key of project.channelOrder) {
    if (!(key in project.channels) || seen.has(key)) continue;
    seen.add(key);
    kept.push(key);
  }
  const missing = Object.keys(project.channels)
    .filter((k) => !seen.has(k))
    .sort();
  if (missing.length > 0 || kept.length !== project.channelOrder.length) {
    project.channelOrder = [...kept, ...missing];
    pushWarning(warnings, "channelOrder", "channelOrder repaired to match channels.");
  }

  // Invariant 3 (partial): clip.trackId names an existing channel; orphans
  // are dropped (there is no channel to invent).
  for (const clipId of Object.keys(project.clips)) {
    const clip = project.clips[clipId];
    if (clip !== undefined && !(clip.trackId in project.channels)) {
      delete project.clips[clipId];
      pushWarning(warnings, `clips.${clipId}`, "Clip referenced a missing channel; dropped.");
    }
  }

  // Audio clips: the same "must live on a real channel" rule, plus two of
  // their own — the asset has to exist, and an id may not name a clip in
  // BOTH maps (a selection holds ids, so one id must mean one clip).
  for (const clipId of Object.keys(project.audioClips)) {
    const clip = project.audioClips[clipId];
    if (clip === undefined) continue;
    if (clipId in project.clips) {
      delete project.audioClips[clipId];
      pushWarning(
        warnings,
        `audioClips.${clipId}`,
        "Id names both a MIDI and an audio clip; the audio one was dropped.",
      );
      continue;
    }
    if (!(clip.trackId in project.channels)) {
      delete project.audioClips[clipId];
      pushWarning(warnings, `audioClips.${clipId}`, "Clip referenced a missing channel; dropped.");
      continue;
    }
    if (!(clip.assetId in project.assets)) {
      // KEPT, not dropped: the sample may simply not have travelled with the
      // project file, and deleting the arrangement because the audio is
      // missing would lose work that a re-import restores.
      pushWarning(
        warnings,
        `audioClips.${clipId}.assetId`,
        "Clip references a sample this project does not have; it will be silent.",
      );
    }
  }

  // Invariants 4 + 5: notes sorted by (start, pitch); ticks/velocity/pitch
  // in range. The parser already clamps on the way in, so this only catches
  // a `Project` handed to `validate()` directly (e.g. after a command
  // storm in a test) rather than one that went through `decode`.
  for (const clipId of Object.keys(project.clips)) {
    const clip = project.clips[clipId];
    if (clip === undefined) continue;
    let changed = false;
    for (const note of clip.notes) {
      const dur = Math.max(1, Math.round(note.dur));
      const pitch = clampInt(note.pitch, 0, 127);
      const vel = clampInt(note.vel, 1, 127);
      const start = Math.max(0, Math.round(note.start));
      if (dur !== note.dur || pitch !== note.pitch || vel !== note.vel || start !== note.start) {
        note.dur = dur;
        note.pitch = pitch;
        note.vel = vel;
        note.start = start;
        changed = true;
      }
    }
    if (!notesAlreadySorted(clip.notes)) {
      clip.notes = [...clip.notes].sort(compareNotes);
      changed = true;
    }
    if (changed) {
      pushWarning(warnings, `clips.${clipId}.notes`, "Notes clamped and/or resorted to satisfy invariants.");
    }
  }

  // --- SS18-M4 hardening: the M2/M3 structures -------------------------------

  // Routing: channel outputs must name existing channels (repaired to null,
  // which the reconciler routes to the destination); sends must land on
  // existing channels; there is at most one master.
  let masterSeen = false;
  // Belt and braces over the invariant-2 repair above: iterating a de-duped
  // id list means no channel can be counted twice here even if `channelOrder`
  // is ever fed to this pass unrepaired.
  for (const channelId of new Set(project.channelOrder)) {
    const channel = project.channels[channelId];
    if (channel === undefined) continue;
    if (channel.role === "master") {
      if (masterSeen) {
        channel.role = "group";
        pushWarning(warnings, `channels.${channelId}`, "Second master demoted to a group.");
      }
      masterSeen = true;
      if (channel.output !== null) {
        channel.output = null;
        pushWarning(warnings, `channels.${channelId}`, "Master output cleared (it targets the destination).");
      }
    } else if (channel.output !== null && !(channel.output in project.channels)) {
      channel.output = null;
      pushWarning(warnings, `channels.${channelId}`, "Output referenced a missing channel; cleared.");
    }
    const validSends = channel.sends.filter((send) => send.to in project.channels && send.to !== channelId);
    if (validSends.length !== channel.sends.length) {
      channel.sends = validSends;
      pushWarning(warnings, `channels.${channelId}.sends`, "Sends to missing channels dropped.");
    }
  }

  // Device chains (SS6 signal flow, invariant 7): a device instance hangs off
  // exactly ONE channel, once. Nothing upstream enforces that — the parser
  // only filters `chain` to strings — and every violation is audible:
  //   - a chain entry naming no device is a dead id the reconciler skips;
  //   - the SAME id twice in one chain makes buildGraph connect that device's
  //     output back to its own input — a zero-delay WebAudio cycle, which per
  //     spec outputs silence, so the channel dies with no warning at all;
  //   - one id in two chains cross-wires one device into two channels and
  //     makes its mount's `channelId` depend on iteration order.
  // First claimer in row order wins; `device.channelId` is then reconciled to
  // the channel that actually lists it.
  const deviceHost = new Map<string, string>();
  const rackHost = new Map<string, string>();
  for (const channelId of project.channelOrder) {
    const channel = project.channels[channelId];
    if (channel === undefined) continue;
    if (channel.source !== null) {
      const deviceId = channel.source.deviceId;
      if (!(deviceId in project.devices) || deviceHost.has(deviceId)) {
        channel.source = null;
        pushWarning(
          warnings,
          `channels.${channelId}.source`,
          "Instrument named a missing or already-claimed device; cleared.",
        );
      } else {
        deviceHost.set(deviceId, channelId);
      }
    }
    // Note chain first, on the same one-device-one-home rule. A rack cannot
    // sit here (a rack is audio wiring), so the entry is always a device.
    const midiChain = (channel.midiChain ?? []).filter((deviceId) => {
      if (!(deviceId in project.devices) || deviceHost.has(deviceId)) return false;
      deviceHost.set(deviceId, channelId);
      return true;
    });
    if (midiChain.length !== (channel.midiChain ?? []).length) {
      pushWarning(
        warnings,
        `channels.${channelId}.midiChain`,
        "Note-chain entries naming missing or duplicated devices dropped.",
      );
    }
    if (midiChain.length === 0) delete channel.midiChain;
    else channel.midiChain = midiChain;

    const chain = channel.chain.filter((entryId) => {
      // A chain slot holds a rack OR a device, never both (invariant 8) —
      // an id in both collections is unresolvable, so the slot is dropped.
      const rack = project.racks[entryId];
      if (rack !== undefined) {
        if (entryId in project.devices || rackHost.has(entryId)) return false;
        rackHost.set(entryId, channelId);
        // Inner devices are claimed here too, so the same device can never
        // sit in a rack chain AND a channel chain.
        for (const inner of rack.chains) {
          inner.devices = inner.devices.filter((deviceId) => {
            if (!(deviceId in project.devices) || deviceHost.has(deviceId)) return false;
            deviceHost.set(deviceId, channelId);
            return true;
          });
        }
        return true;
      }
      if (!(entryId in project.devices) || deviceHost.has(entryId)) return false;
      deviceHost.set(entryId, channelId);
      return true;
    });
    if (chain.length !== channel.chain.length) {
      channel.chain = chain;
      pushWarning(
        warnings,
        `channels.${channelId}.chain`,
        "Chain entries naming missing or duplicated devices dropped.",
      );
    }
  }
  for (const [deviceId, host] of deviceHost) {
    const device = project.devices[deviceId];
    if (device !== undefined && device.channelId !== host) {
      device.channelId = host;
      pushWarning(warnings, `devices.${deviceId}.channelId`, "Device re-homed to the channel that lists it.");
    }
  }

  // Racks (invariant 8). An unclaimed rack is unreachable — no chain slot
  // names it — so it would be invisible, unplayable and unsavable-away; drop
  // it with its inner devices. A claimed one is re-homed to the channel that
  // lists it, and its chain params are rebuilt on that channel's path so a
  // re-homed rack's gain/pan keep pointing at their own values.
  for (const rackId of Object.keys(project.racks)) {
    const rack = project.racks[rackId];
    if (rack === undefined) continue;
    const host = rackHost.get(rackId);
    if (host === undefined) {
      for (const chain of rack.chains) {
        for (const deviceId of chain.devices) delete project.devices[deviceId];
      }
      delete project.racks[rackId];
      pushWarning(warnings, `racks.${rackId}`, "Rack no chain slot referenced; dropped with its devices.");
      continue;
    }
    if (rack.channelId !== host) {
      rack.channelId = host;
      pushWarning(warnings, `racks.${rackId}.channelId`, "Rack re-homed to the channel that lists it.");
    }
    for (const chain of rack.chains) {
      for (const leaf of ["gain", "pan"] as const) {
        const expected = rackChainParamId(host, rackId, chain.id, leaf);
        if (chain[leaf] === expected) continue;
        const carried = project.paramValues[chain[leaf]];
        delete project.paramValues[chain[leaf]];
        if (carried !== undefined) project.paramValues[expected] = carried;
        chain[leaf] = expected;
        pushWarning(warnings, `racks.${rackId}.chains`, "Chain param id rebuilt on the hosting channel.");
      }
    }
  }

  // Sidechains: both endpoints must exist and the device must not key its
  // own channel. Runs BEFORE the cycle check — a self-keying edge IS a
  // one-node cycle, and this is its targeted repair.
  const validEdges = project.sidechains.filter((edge) => {
    const device = project.devices[edge.to.device];
    if (device === undefined) return false;
    if (!(edge.from.channel in project.channels)) return false;
    // A same-channel edge is legal from the `preFx` tap only: that tap is the
    // channel input, upstream of every device in the chain, so it is
    // feed-forward rather than a loop (gated reverb keys a gate exactly this
    // way). The other two taps sit downstream and really would cycle.
    if (device.channelId === edge.from.channel) {
      return sidechainIsFeedForward(edge.from.channel, device.channelId, edge.from.tap);
    }
    return true;
  });
  if (validEdges.length !== project.sidechains.length) {
    project.sidechains = validEdges;
    pushWarning(warnings, "sidechains", "Sidechain edges with missing endpoints, or self-keyed from a downstream tap, dropped.");
  }

  // Routing cycles (SS6): broken by clearing the cycle's first channel's
  // output, then its sends, then any sidechain edges it feeds — audible-safe
  // (the channel then feeds the destination directly) and loud in the
  // warnings. Each pass removes at least one edge, so this terminates.
  //
  // Bounded by the GRAPH, not by a constant: each pass clears one of
  // {output, sends, sidechains} on one channel, so 3 passes per channel is
  // the worst case. A constant bound (this was 64) let a file with more
  // independent cycles than the bound decode `ok: true` with cycles still in
  // it — silent channels, and an untrusted-input pass claiming a repair it
  // did not make.
  const channelCount = Object.keys(project.channels).length;
  for (let guard = 0; guard < channelCount * 3 + 8; guard++) {
    const cycle = findRoutingCycle(project);
    if (cycle === null) break;
    const first = cycle[0];
    const channel = first !== undefined ? project.channels[first] : undefined;
    if (first === undefined || channel === undefined) break;
    if (channel.output !== null) {
      channel.output = null;
    } else if (channel.sends.length > 0) {
      channel.sends = [];
    } else {
      project.sidechains = project.sidechains.filter((edge) => edge.from.channel !== first);
    }
    pushWarning(warnings, `channels.${first}`, `Routing cycle broken (${cycle.join(" -> ")}).`);
  }
  // Unreachable given the bound above, but `decode` must never hand the
  // reconciler a document it KNOWS is cyclic: cut every outgoing edge of the
  // offending channel at once, which strictly shrinks the edge set each pass.
  for (let guard = 0; guard <= channelCount; guard++) {
    const cycle = findRoutingCycle(project);
    if (cycle === null) break;
    const first = cycle[0];
    const channel = first !== undefined ? project.channels[first] : undefined;
    if (first === undefined || channel === undefined) break;
    channel.output = null;
    channel.sends = [];
    project.sidechains = project.sidechains.filter((edge) => edge.from.channel !== first);
    pushWarning(warnings, `channels.${first}`, `Routing cycle broken (${cycle.join(" -> ")}).`);
  }

  // Lanes (SS11): channel must exist; points sorted by t, one per tick,
  // curve clamped to [-1, 1], ticks non-negative integers.
  for (const laneId of Object.keys(project.lanes)) {
    const lane = project.lanes[laneId];
    if (lane === undefined) continue;
    if (!(lane.channelId in project.channels)) {
      delete project.lanes[laneId];
      pushWarning(warnings, `lanes.${laneId}`, "Lane referenced a missing channel; dropped.");
      continue;
    }
    let changed = false;
    for (const point of lane.points) {
      const t = Math.max(0, Math.round(point.t));
      const curve = Math.min(1, Math.max(-1, point.curve));
      if (t !== point.t || curve !== point.curve || !Number.isFinite(point.v)) {
        point.t = t;
        point.curve = Number.isFinite(curve) ? curve : 0;
        if (!Number.isFinite(point.v)) point.v = 0;
        changed = true;
      }
    }
    const sorted = [...lane.points].sort((a, b) => a.t - b.t);
    const deduped: typeof sorted = [];
    for (const point of sorted) {
      const last = deduped[deduped.length - 1];
      if (last !== undefined && last.t === point.t) deduped[deduped.length - 1] = point;
      else deduped.push(point);
    }
    if (changed || deduped.length !== lane.points.length || deduped.some((pt, i) => pt !== lane.points[i])) {
      lane.points = deduped;
      pushWarning(warnings, `lanes.${laneId}.points`, "Automation points clamped/resorted to satisfy invariants.");
    }
  }

  return warnings;
}

// -----------------------------------------------------------------------
// public factory
// -----------------------------------------------------------------------

function withMigratedFrom(base: {
  ok: true;
  project: Project;
  warnings: readonly LoadWarning[];
}, migratedFrom: number | undefined): DecodeResult {
  return migratedFrom === undefined ? base : { ...base, migratedFrom };
}

function withSchemaVersion(
  base: { ok: false; error: string },
  schemaVersion: number | undefined,
): DecodeResult {
  return schemaVersion === undefined ? base : { ...base, schemaVersion };
}

function decodeValue(value: JsonValue): DecodeResult {
  if (!isJsonObject(value)) {
    return withSchemaVersion({ ok: false, error: NOT_A_PROJECT_FILE }, undefined);
  }
  if (value["format"] !== FORMAT_MARKER) {
    return withSchemaVersion({ ok: false, error: NOT_A_PROJECT_FILE }, undefined);
  }

  const schemaVersionRaw = value["schemaVersion"];
  const schemaVersion = typeof schemaVersionRaw === "number" ? schemaVersionRaw : 0;

  const projectRaw = value["project"];
  if (projectRaw === undefined) {
    return withSchemaVersion({ ok: false, error: NOT_A_PROJECT_FILE }, schemaVersion);
  }

  const migration = runMigrations(schemaVersion, projectRaw);
  if (migration.error !== undefined) {
    return withSchemaVersion({ ok: false, error: migration.error }, schemaVersion);
  }

  const warnings: LoadWarning[] = [];
  const parsed = parseProject(migration.value, warnings);
  if ("error" in parsed) {
    return withSchemaVersion({ ok: false, error: parsed.error }, schemaVersion);
  }

  const repairWarnings = validateProject(parsed.project);
  return withMigratedFrom(
    { ok: true, project: parsed.project, warnings: [...warnings, ...repairWarnings] },
    migration.migratedFrom,
  );
}

function decode(text: string): DecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not a Fableton project file: the text is not valid JSON." };
  }
  return decodeValue(value as JsonValue);
}

/** Creates a fresh `ProjectCodec`. Stateless (bar an internal fallback-id
 *  counter used only when a file is missing an id it structurally needs),
 *  so one instance is safe to share across a whole app session. */
export function createProjectCodec(): ProjectCodec {
  return { encode, decode, decodeValue, validate: validateProject };
}

/** Ready-made shared instance, mirroring `command-undo`'s
 *  `projectCommands` convenience export. */
export const projectCodec: ProjectCodec = createProjectCodec();
