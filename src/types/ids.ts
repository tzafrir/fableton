// Stable document ids. All plain `string` on purpose (SS4 declares
// `type ParamId = string`): ids are serialized verbatim into project JSON
// and into automation lanes / MIDI mappings, so they must survive a
// JSON round-trip with no branding ceremony.

/**
 * A parameter's global address (SS4).
 *
 * Format — hierarchical path segments joined by `/`:
 *
 *   device param : `chan:<ChannelId>/dev:<DeviceInstanceId>/<localId>`
 *   mixer volume : `chan:<ChannelId>/vol`
 *   mixer pan    : `chan:<ChannelId>/pan`
 *   send amount  : `chan:<ChannelId>/send:<ChannelId>`
 *
 * `<localId>` is the device-local param id declared by the
 * `DeviceDefinition` (SS7: local ids are public API — renaming one needs a
 * migration). The `src/params` package owns the builder/parser functions
 * for these strings; nothing else should concatenate them by hand.
 */
export type ParamId = string;

/** A channel: track, group, return, or master (SS6). Also a track id. */
export type ChannelId = string;

/** Id of a registered `DeviceDefinition`, e.g. `"core.poly-synth"` (SS7). */
export type DeviceDefinitionId = string;

/** Id of one instantiated device inside a channel's chain or source slot. */
export type DeviceInstanceId = string;

/** Id of a clip in the arrangement (SS10). */
export type ClipId = string;

/** Id of a note inside a clip (SS10). */
export type NoteId = string;

/** Id of an effect rack (SS7 "racks"): a container of PARALLEL device
 *  chains occupying one slot of a channel's chain. A rack id lives in the
 *  same namespace as a `DeviceInstanceId` — it sits in `Channel.chain` and
 *  is the `dev:` segment of its params' ids — but resolves through
 *  `Project.racks`, never `Project.devices`. */
export type RackId = string;

/** Id of one parallel chain inside a rack. */
export type RackChainId = string;

/** Id of a rack macro knob (SS7): one control fanned out to N params. */
export type RackMacroId = string;

/** Id of an automation lane (SS11). Reserved for M3; declared here so the
 *  id vocabulary lives in one place. */
export type LaneId = string;
