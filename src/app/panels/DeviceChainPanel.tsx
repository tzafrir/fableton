// SS7/SS5/SS6 — the selected channel's device chain.
//
// - Instrument slot (tracks): pick/replace the source instrument. The SS7
//   swap carries compatible params: the CALLER computes the carry map here
//   (it knows both definitions), the command applies it — clips untouched.
// - Effect chain: add (from the registry's `audioEffect` list), enable
//   toggle, reorder, remove. Every edit is one document command; the
//   reconciler turns it into a patch.
// - Panels: a definition with no `panel` gets the SS5 DEFAULT panel — every
//   descriptor as a control, kind -> control, four per row.
// - "Audio From" (SS6): rendered on any device whose definition declares an
//   `'sc'` input port; writes an explicit `SidechainEdge`.

import { useEffect, useMemo, useState } from "react";
import { CORE_DEVICES } from "../../devices/core";
import { presetStore } from "../../presets/store";
import { deviceParamId } from "../../params";
import type { AppProjectEngine } from "../engine";
import type {
  ChannelId,
  Command,
  CommandResult,
  DeviceDefinition,
  DeviceInstanceId,
  DocumentStore,
  PanelSpec,
  ParamHandle,
  ParamId,
  ProjectCommands,
  ProjectSnapshot,
  RackChainId,
  RackId,
  SidechainEdge,
} from "../../types";
import { EnumSelect, Knob, ToggleLED, controlKindFor } from "../../ui/controls";
import { rejectionHintStyle, useDispatchHint } from "./useDispatchHint";

export interface DeviceChainPanelProps {
  store: DocumentStore;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  channelId: ChannelId | null;
  /** SS5's control context menu: "Show/create automation lane" — the shell
   *  creates (or re-enables) that param's lane and reveals it. */
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
}

/** Where a rendered device instance lives. */
export type DeviceContainer =
  | { kind: "source" }
  | { kind: "channel" }
  | { kind: "rackChain"; rackId: RackId; chainId: RackChainId };

const definitionsById = new Map(CORE_DEVICES.map((d) => [d.id, d]));
const instrumentDefs = CORE_DEVICES.filter((d) => d.kind === "instrument");
const effectDefs = CORE_DEVICES.filter((d) => d.kind === "audioEffect");

/** SS7 swap carry: values for params whose LOCAL id exists on both sides
 *  with an overlapping range; everything else takes defaults. */
export function carryValuesForSwap(
  doc: ProjectSnapshot,
  channelId: ChannelId,
  oldDeviceId: DeviceInstanceId | undefined,
  oldDef: DeviceDefinition | undefined,
  newDef: DeviceDefinition,
): Record<string, number> {
  const carry: Record<string, number> = {};
  if (oldDeviceId === undefined || oldDef === undefined) return carry;
  for (const desc of newDef.params) {
    const oldDesc = oldDef.params.find((p) => p.id === desc.id);
    if (oldDesc === undefined) continue;
    const value = doc.paramValues[deviceParamId(channelId, oldDeviceId, desc.id)];
    if (value === undefined) continue;
    if (value < desc.min || value > desc.max) continue; // range-incompatible
    carry[desc.id] = value;
  }
  return carry;
}

/** SS5 default panel: every param, four controls per row. */
function defaultPanel(def: DeviceDefinition): PanelSpec {
  const rows: PanelSpec["rows"] = [];
  for (let i = 0; i < def.params.length; i += 4) {
    rows.push({ controls: def.params.slice(i, i + 4).map((p) => ({ paramId: p.id })) });
  }
  return { rows };
}

function ParamControlFor({
  handle,
  onShowAutomation,
}: {
  handle: ParamHandle;
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
}) {
  const kind = controlKindFor(handle.desc);
  if (kind === "toggle") return <ToggleLED handle={handle} testId={`ctl-${handle.desc.id}`} />;
  if (kind === "enumSelect") return <EnumSelect handle={handle} testId={`ctl-${handle.desc.id}`} />;
  return (
    <Knob
      handle={handle}
      testId={`ctl-${handle.desc.id}`}
      onShowAutomation={
        onShowAutomation === undefined ? undefined : () => onShowAutomation(handle.desc.id)
      }
    />
  );
}

function DevicePanel({
  doc,
  dispatch,
  commands,
  engine,
  channelId,
  deviceId,
  container,
  onShowAutomation,
}: {
  doc: ProjectSnapshot;
  /** The panel's rejection-aware dispatch (SS6 inline hint) — see
   *  `useDispatchHint`; the sidechain picker is the edit that gets rejected. */
  dispatch: (command: Command) => CommandResult;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  channelId: ChannelId;
  deviceId: DeviceInstanceId;
  /** Where this device sits — the instrument slot has no reorder/remove at
   *  all, a channel chain reorders by chain index, a rack chain by its own.
   *  Same panel, three containers. */
  container: DeviceContainer;
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
}) {
  const device = doc.devices[deviceId];
  const def = device !== undefined ? definitionsById.get(device.definitionId) : undefined;
  // `presetStore.save` writes localStorage and notifies nobody, so the picker
  // below — a plain render-time `list()` — kept showing the previous set and
  // the user could not recall the preset they had just saved. This revision
  // is the local notification (SS4 presets / SS18-M4).
  const [presetRevision, setPresetRevision] = useState(0);
  const presets = useMemo(
    () => (def === undefined ? [] : presetStore.list(def.id)),
    [def, presetRevision],
  );
  if (device === undefined) return null;

  const label = def?.label ?? device.definitionId;
  const panel = def?.panel ?? (def !== undefined ? defaultPanel(def) : { rows: [] });
  const hasScPort = def?.audioIn.some((port) => port.id === "sc") ?? false;
  const scEdge = doc.sidechains.find((e) => e.to.device === deviceId && e.to.port === "sc");
  const inChain = container.kind !== "source";
  const siblings =
    container.kind === "rackChain"
      ? (doc.racks[container.rackId]?.chains.find((c) => c.id === container.chainId)?.devices ?? [])
      : (doc.channels[channelId]?.chain ?? []);
  const index = siblings.indexOf(deviceId);
  /** Reorder within whichever list holds this device. `moveDeviceToChain`
   *  detaches then re-inserts, so the same index arithmetic works for both. */
  const moveTo = (to: number): void => {
    if (container.kind === "rackChain") {
      dispatch(commands.moveDeviceToChain(container.rackId, deviceId, container.chainId, to));
    } else {
      dispatch(commands.moveDevice(channelId, deviceId, to));
    }
  };

  return (
    <div
      className="fbl-device"
      data-testid={`device-${deviceId}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        border: "1px solid #333",
        borderRadius: 4,
        padding: 6,
        // The chain scrolls horizontally, so a device keeps its size rather
        // than being squeezed by the ones after it — a shrunk panel pushes
        // its own controls outside its border.
        minWidth: 150,
        maxWidth: 240,
        flex: "0 0 auto",
        opacity: device.enabled ? 1 : 0.5,
      }}
    >
      {/* Header, in TWO rows on purpose. As one row it packed the enable
          dot, the title, the preset picker, save, and ◀ ▶ ✕ into a box whose
          `minWidth` is 150 — the row needs ~224px, so with a few effects in
          the chain the trailing buttons overflowed the panel's own border and
          landed on top of the NEXT device's title. Splitting the row keeps
          every control inside the box it belongs to. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          data-testid={`device-enable-${deviceId}`}
          role="switch"
          aria-checked={device.enabled}
          title={device.enabled ? "Disable" : "Enable"}
          onClick={() => dispatch(commands.setDeviceEnabled(deviceId, !device.enabled))}
          style={{
            width: 12,
            height: 12,
            flex: "0 0 auto",
            borderRadius: "50%",
            border: "1px solid #555",
            background: device.enabled ? "#7ad67a" : "#222",
            cursor: "pointer",
            padding: 0,
          }}
        />
        {/* `minWidth: 0` is what lets the name ellipsize instead of forcing
            the row wider than the panel. */}
        <span
          title={label}
          style={{
            fontSize: 12,
            color: "#ddd",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        {inChain && (
          <button
            type="button"
            data-testid={`device-remove-${deviceId}`}
            title="Remove device"
            onClick={() => dispatch(commands.removeDevices([deviceId]))}
            style={tinyButton}
          >
            ✕
          </button>
        )}
      </div>

      {(def !== undefined || inChain) && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {def !== undefined && (
            <>
              <select
                data-testid={`preset-select-${deviceId}`}
                aria-label="Preset"
                value=""
                onChange={(e) => {
                  const preset = presets.find((entry) => entry.name === e.target.value);
                  if (preset === undefined) return;
                  // One undo entry for the whole bag (SS4 "presets are bags of
                  // parameter values"); unknown/out-of-range ids are dropped.
                  const values: Record<string, number> = {};
                  for (const [localId, value] of Object.entries(preset.values)) {
                    if (def.params.some((p) => p.id === localId)) {
                      values[deviceParamId(channelId, deviceId, localId)] = value;
                    }
                  }
                  dispatch(commands.setParamValues(values));
                }}
                style={{ fontSize: 10, flex: 1, minWidth: 0, background: "#181818", color: "#bbb" }}
              >
                <option value="">presets…</option>
                {presets.map((preset) => (
                  <option key={preset.name} value={preset.name}>
                    {preset.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid={`preset-save-${deviceId}`}
                title="Save current values as a preset"
                onClick={() => {
                  const name = window.prompt("Preset name");
                  if (name === null || name.trim() === "") return;
                  const values: Record<string, number> = {};
                  for (const paramDesc of def.params) {
                    const stored = doc.paramValues[deviceParamId(channelId, deviceId, paramDesc.id)];
                    values[paramDesc.id] = stored ?? paramDesc.defaultValue;
                  }
                  presetStore.save(def.id, name, values);
                  setPresetRevision((n) => n + 1);
                }}
                style={tinyButton}
              >
                ⭳
              </button>
            </>
          )}
          {inChain && (
            <span style={{ display: "inline-flex", gap: 4, marginLeft: "auto" }}>
              {container.kind === "channel" && (
                <button
                  type="button"
                  data-testid={`device-group-${deviceId}`}
                  title="Group into a rack (parallel chains)"
                  onClick={() => dispatch(commands.groupIntoRack(channelId, [deviceId]))}
                  style={tinyButton}
                >
                  ⧉
                </button>
              )}
              <button
                type="button"
                data-testid={`device-left-${deviceId}`}
                title="Move earlier in the chain"
                disabled={index <= 0}
                onClick={() => moveTo(index - 1)}
                style={tinyButton}
              >
                ◀
              </button>
              <button
                type="button"
                data-testid={`device-right-${deviceId}`}
                title="Move later in the chain"
                disabled={index < 0 || index >= siblings.length - 1}
                onClick={() => moveTo(index + 1)}
                style={tinyButton}
              >
                ▶
              </button>
            </span>
          )}
        </div>
      )}

      {/* SS6 "Audio From" — the sidechain picker, exactly like Ableton's. */}
      {hasScPort && (
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "#888", flex: "0 0 auto" }}>Audio From</span>
          <select
            data-testid={`sc-source-${deviceId}`}
            value={scEdge?.from.channel ?? ""}
            onChange={(e) => {
              const from = e.target.value;
              if (from === "") {
                dispatch(commands.removeSidechain(deviceId, "sc"));
                return;
              }
              // Keying this device's OWN channel is legal only from `preFx`
              // (the channel input, upstream of the whole chain) — so that is
              // what a same-channel pick lands on, rather than offering a tap
              // the routing rules will reject. This is the gated-reverb path.
              const sameChannel = from === channelId;
              const keptTap = scEdge?.from.tap ?? "postFader";
              const edge: SidechainEdge = {
                from: { channel: from, tap: sameChannel ? "preFx" : keptTap },
                to: { device: deviceId, port: "sc" },
              };
              dispatch(commands.setSidechain(edge));
            }}
            style={{ fontSize: 10, minWidth: 0, maxWidth: 138, background: "#181818", color: "#bbb" }}
          >
            <option value="">None</option>
            {doc.channelOrder.map((id) => (
              <option key={id} value={id}>
                {id === channelId
                  ? `${doc.channels[id]?.name ?? id} (this channel)`
                  : (doc.channels[id]?.name ?? id)}
              </option>
            ))}
          </select>
          {scEdge !== undefined && (
            <select
              data-testid={`sc-tap-${deviceId}`}
              value={scEdge.from.tap}
              onChange={(e) =>
                dispatch(
                  commands.setSidechain({
                    from: { channel: scEdge.from.channel, tap: e.target.value as SidechainEdge["from"]["tap"] },
                    to: { device: deviceId, port: "sc" },
                  }),
                )
              }
              style={{ fontSize: 10, minWidth: 0, maxWidth: 138, background: "#181818", color: "#bbb" }}
            >
              <option value="preFx">Pre FX</option>
              <option value="postFx" disabled={scEdge.from.channel === channelId}>
                Post FX
              </option>
              <option value="postFader" disabled={scEdge.from.channel === channelId}>
                Post Fader
              </option>
            </select>
          )}
        </div>
      )}

      {/* Param rows (SS5): registry handles exist only once audio is up. */}
      {panel.rows.map((row, i) => (
        <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {/* SS5 panel rows may name themselves — the drum machine's do, one
              row per pad, and without this the eight pads' 24 knobs were an
              undifferentiated grid. */}
          {row.label !== undefined && (
            <span style={{ fontSize: 10, color: "#8a8f99", minWidth: 74 }}>{row.label}</span>
          )}
          {row.controls.map((spec) => {
            const handle = engine?.params.get(deviceParamId(channelId, deviceId, spec.paramId));
            if (handle === undefined) {
              return (
                <span key={spec.paramId} style={{ fontSize: 10, color: "#444" }}>
                  {spec.paramId}
                </span>
              );
            }
            return (
              <ParamControlFor
                key={spec.paramId}
                handle={handle}
                onShowAutomation={onShowAutomation}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * SS7 rack: the split/sum container, drawn as a column of parallel chains.
 *
 * Each chain gets the same three controls the graph gives it — mute, solo
 * and gain/pan — so what the panel shows is exactly what `buildGraph`
 * expands, and chain solo is a gain change here for the same reason it is
 * one in the engine.
 */
function RackPanel({
  doc,
  dispatch,
  commands,
  engine,
  channelId,
  rackId,
  onShowAutomation,
}: {
  doc: ProjectSnapshot;
  dispatch: (command: Command) => CommandResult;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  channelId: ChannelId;
  rackId: RackId;
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
}) {
  const rack = doc.racks[rackId];
  const slots = doc.channels[channelId]?.chain ?? [];
  const index = slots.indexOf(rackId);
  if (rack === undefined) return null;

  return (
    <div
      className="fbl-rack"
      data-testid={`rack-${rackId}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        border: "1px solid #4a4a55",
        borderRadius: 4,
        padding: 6,
        background: "#1b1b20",
        flex: "0 0 auto",
        opacity: rack.enabled ? 1 : 0.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          data-testid={`rack-enable-${rackId}`}
          role="switch"
          aria-checked={rack.enabled}
          title={rack.enabled ? "Disable rack" : "Enable rack"}
          onClick={() => dispatch(commands.setRackEnabled(rackId, !rack.enabled))}
          style={{
            width: 12,
            height: 12,
            flex: "0 0 auto",
            borderRadius: "50%",
            border: "1px solid #555",
            background: rack.enabled ? "#7ad67a" : "#222",
            cursor: "pointer",
            padding: 0,
          }}
        />
        <input
          data-testid={`rack-name-${rackId}`}
          aria-label="Rack name"
          value={rack.name}
          onChange={(e) => dispatch(commands.renameRack(rackId, e.target.value))}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            background: "transparent",
            color: "#dde",
            border: "1px solid transparent",
            borderRadius: 2,
            padding: "1px 2px",
          }}
        />
        <button
          type="button"
          data-testid={`rack-remove-${rackId}`}
          title="Remove rack and everything in it"
          onClick={() => dispatch(commands.removeDevices([rackId]))}
          style={tinyButton}
        >
          ✕
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          type="button"
          data-testid={`rack-add-chain-${rackId}`}
          title="Add a parallel chain"
          onClick={() => dispatch(commands.addRackChain(rackId))}
          style={tinyButton}
        >
          + Chain
        </button>
        <button
          type="button"
          data-testid={`rack-ungroup-${rackId}`}
          title="Dissolve the rack back into the channel chain"
          onClick={() => dispatch(commands.ungroupRack(rackId))}
          style={tinyButton}
        >
          Ungroup
        </button>
        <span style={{ display: "inline-flex", gap: 4, marginLeft: "auto" }}>
          <button
            type="button"
            data-testid={`rack-left-${rackId}`}
            title="Move earlier in the chain"
            disabled={index <= 0}
            onClick={() => dispatch(commands.moveDevice(channelId, rackId, index - 1))}
            style={tinyButton}
          >
            ◀
          </button>
          <button
            type="button"
            data-testid={`rack-right-${rackId}`}
            title="Move later in the chain"
            disabled={index < 0 || index >= slots.length - 1}
            onClick={() => dispatch(commands.moveDevice(channelId, rackId, index + 1))}
            style={tinyButton}
          >
            ▶
          </button>
        </span>
      </div>

      {rack.chains.map((chain) => {
        const gain = engine?.params.get(chain.gain);
        const pan = engine?.params.get(chain.pan);
        return (
          <div
            key={chain.id}
            className="fbl-rack-chain"
            data-testid={`chain-${rackId}-${chain.id}`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              border: "1px solid #333",
              borderRadius: 3,
              padding: 4,
              background: "#17171b",
              opacity: chain.mute && !chain.solo ? 0.55 : 1,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                data-testid={`chain-name-${rackId}-${chain.id}`}
                aria-label="Chain name"
                value={chain.name}
                onChange={(e) => dispatch(commands.renameRackChain(rackId, chain.id, e.target.value))}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 10,
                  background: "transparent",
                  color: "#bbb",
                  border: "1px solid transparent",
                  borderRadius: 2,
                  padding: "1px 2px",
                }}
              />
              <button
                type="button"
                data-testid={`chain-mute-${rackId}-${chain.id}`}
                aria-pressed={chain.mute}
                title="Mute this chain"
                onClick={() => dispatch(commands.setChainMuted(rackId, chain.id, !chain.mute))}
                style={{ ...tinyButton, background: chain.mute ? "#c58f00" : "#222", color: chain.mute ? "#000" : "#999" }}
              >
                M
              </button>
              <button
                type="button"
                data-testid={`chain-solo-${rackId}-${chain.id}`}
                aria-pressed={chain.solo}
                title="Solo this chain (inside this rack only)"
                onClick={() => dispatch(commands.setChainSolo(rackId, chain.id, !chain.solo))}
                style={{ ...tinyButton, background: chain.solo ? "#2d7ff0" : "#222", color: chain.solo ? "#fff" : "#999" }}
              >
                S
              </button>
              <button
                type="button"
                data-testid={`chain-remove-${rackId}-${chain.id}`}
                title="Remove this chain and its devices"
                onClick={() => dispatch(commands.removeRackChain(rackId, chain.id))}
                style={tinyButton}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {gain === undefined ? (
                <span style={{ fontSize: 10, color: "#444" }}>gain</span>
              ) : (
                <Knob
                  handle={gain}
                  size={26}
                  label="Gain"
                  testId={`chain-gain-${rackId}-${chain.id}`}
                  onShowAutomation={onShowAutomation === undefined ? undefined : () => onShowAutomation(chain.gain)}
                />
              )}
              {pan === undefined ? (
                <span style={{ fontSize: 10, color: "#444" }}>pan</span>
              ) : (
                <Knob
                  handle={pan}
                  size={26}
                  label="Pan"
                  testId={`chain-pan-${rackId}-${chain.id}`}
                  onShowAutomation={onShowAutomation === undefined ? undefined : () => onShowAutomation(chain.pan)}
                />
              )}
            </div>

            <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
              {chain.devices.map((deviceId) => (
                <DevicePanel
                  key={deviceId}
                  doc={doc}
                  dispatch={dispatch}
                  commands={commands}
                  engine={engine}
                  channelId={channelId}
                  deviceId={deviceId}
                  container={{ kind: "rackChain", rackId, chainId: chain.id }}
                  onShowAutomation={onShowAutomation}
                />
              ))}
              <select
                data-testid={`chain-add-effect-${rackId}-${chain.id}`}
                aria-label="Add effect to chain"
                value=""
                onChange={(e) => {
                  const def = definitionsById.get(e.target.value);
                  if (def === undefined) return;
                  dispatch(
                    commands.addEffectToChain(rackId, chain.id, {
                      definitionId: def.id,
                      version: def.version,
                    }),
                  );
                }}
                style={{ fontSize: 10, background: "#181818", color: "#bbb", alignSelf: "center" }}
              >
                <option value="" disabled>
                  + Effect…
                </option>
                {effectDefs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DeviceChainPanel({
  store,
  commands,
  engine,
  channelId,
  onShowAutomation,
}: DeviceChainPanelProps) {
  const [, force] = useState(0);
  useEffect(() => store.onChange(() => force((n) => n + 1)), [store]);
  // Param handles are read during render but registered ASYNCHRONOUSLY:
  // `host.mount` awaits the definition's `prepare()` (SS7), so a device added
  // now gets its handles well after React flushed the render for that
  // document change. Without this subscription the freshly added effect
  // renders the dead `<span>{spec.paramId}</span>` placeholders instead of
  // its controls until some unrelated edit re-renders the panel (SS5).
  useEffect(() => {
    if (engine === null) return;
    return engine.params.onRegistryChange(() => force((n) => n + 1));
  }, [engine]);
  const { hint, dispatch } = useDispatchHint(store);
  const doc = store.getState();
  const channel = channelId !== null ? doc.channels[channelId] : undefined;

  if (channel === undefined) {
    return (
      <div data-testid="device-chain-panel" style={{ padding: 12, color: "#666", fontSize: 12 }}>
        Select a channel to see its devices.
      </div>
    );
  }

  const sourceDevice = channel.source !== null ? doc.devices[channel.source.deviceId] : undefined;
  const sourceDef = sourceDevice !== undefined ? definitionsById.get(sourceDevice.definitionId) : undefined;

  return (
    <div
      className="fbl-device-chain"
      data-testid="device-chain-panel"
      style={{ display: "flex", gap: 8, padding: 8, overflowX: "auto", alignItems: "flex-start" }}
    >
      {/* Instrument slot (tracks only, SS7) */}
      {channel.role === "track" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "0 0 auto" }}>
          <select
            data-testid="instrument-select"
            aria-label="Instrument"
            value={sourceDevice?.definitionId ?? ""}
            onChange={(e) => {
              const def = definitionsById.get(e.target.value);
              if (def === undefined) return;
              const carry = carryValuesForSwap(
                doc,
                channel.id,
                sourceDevice?.id,
                sourceDef,
                def,
              );
              dispatch(
                commands.setInstrument(channel.id, { definitionId: def.id, version: def.version }, carry),
              );
            }}
            style={{ fontSize: 11, background: "#181818", color: "#bbb" }}
          >
            <option value="" disabled>
              (no instrument)
            </option>
            {instrumentDefs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          {sourceDevice !== undefined && (
            <DevicePanel
              doc={doc}
              dispatch={dispatch}
              commands={commands}
              engine={engine}
              channelId={channel.id}
              deviceId={sourceDevice.id}
              container={{ kind: "source" }}
              onShowAutomation={onShowAutomation}
            />
          )}
        </div>
      )}

      {/* Effect chain, in order. A slot holds a device OR a rack. */}
      {channel.chain.map((entryId) =>
        doc.racks[entryId] !== undefined ? (
          <RackPanel
            key={entryId}
            doc={doc}
            dispatch={dispatch}
            commands={commands}
            engine={engine}
            channelId={channel.id}
            rackId={entryId}
            onShowAutomation={onShowAutomation}
          />
        ) : (
          <DevicePanel
            key={entryId}
            doc={doc}
            dispatch={dispatch}
            commands={commands}
            engine={engine}
            channelId={channel.id}
            deviceId={entryId}
            container={{ kind: "channel" }}
            onShowAutomation={onShowAutomation}
          />
        ),
      )}

      {/* Add-effect caret (SS7: "into a chain at a drop caret") */}
      <select
        data-testid="add-effect-select"
        aria-label="Add effect"
        value=""
        onChange={(e) => {
          const def = definitionsById.get(e.target.value);
          if (def !== undefined) {
            dispatch(commands.addEffect(channel.id, { definitionId: def.id, version: def.version }));
          }
        }}
        style={{ fontSize: 11, background: "#181818", color: "#bbb", alignSelf: "center", flex: "0 0 auto" }}
      >
        <option value="" disabled>
          + Add effect…
        </option>
        {effectDefs.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        data-testid="add-rack-button"
        title="Add an empty rack (parallel chains)"
        onClick={() => dispatch(commands.addRack(channel.id))}
        style={{ ...tinyButton, alignSelf: "center", fontSize: 11, padding: "2px 6px" }}
      >
        + Rack
      </button>

      {/* SS6: a rejected edit (a sidechain that would close a cycle) says so
          inline instead of looking like nothing happened. */}
      {hint !== null && (
        <span data-testid="device-chain-hint" role="status" style={{ ...rejectionHintStyle, alignSelf: "center" }}>
          {hint}
        </span>
      )}
    </div>
  );
}

const tinyButton: React.CSSProperties = {
  fontSize: 10,
  flex: "0 0 auto",
  background: "#222",
  color: "#999",
  border: "1px solid #444",
  borderRadius: 3,
  cursor: "pointer",
  padding: "0 4px",
};
