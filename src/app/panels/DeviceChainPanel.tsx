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

import { useEffect, useState } from "react";
import { CORE_DEVICES } from "../../devices/core";
import { presetStore } from "../../presets/store";
import { deviceParamId } from "../../params";
import type { AppProjectEngine } from "../engine";
import type {
  ChannelId,
  DeviceDefinition,
  DeviceInstanceId,
  DocumentStore,
  PanelSpec,
  ParamHandle,
  ProjectCommands,
  ProjectSnapshot,
  SidechainEdge,
} from "../../types";
import { EnumSelect, Knob, ToggleLED, controlKindFor } from "../../ui/controls";

export interface DeviceChainPanelProps {
  store: DocumentStore;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  channelId: ChannelId | null;
}

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

function ParamControlFor({ handle }: { handle: ParamHandle }) {
  const kind = controlKindFor(handle.desc);
  if (kind === "toggle") return <ToggleLED handle={handle} testId={`ctl-${handle.desc.id}`} />;
  if (kind === "enumSelect") return <EnumSelect handle={handle} testId={`ctl-${handle.desc.id}`} />;
  return <Knob handle={handle} testId={`ctl-${handle.desc.id}`} />;
}

function DevicePanel({
  doc,
  store,
  commands,
  engine,
  channelId,
  deviceId,
  inChain,
}: {
  doc: ProjectSnapshot;
  store: DocumentStore;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  channelId: ChannelId;
  deviceId: DeviceInstanceId;
  inChain: boolean;
}) {
  const device = doc.devices[deviceId];
  const def = device !== undefined ? definitionsById.get(device.definitionId) : undefined;
  if (device === undefined) return null;

  const label = def?.label ?? device.definitionId;
  const panel = def?.panel ?? (def !== undefined ? defaultPanel(def) : { rows: [] });
  const hasScPort = def?.audioIn.some((port) => port.id === "sc") ?? false;
  const scEdge = doc.sidechains.find((e) => e.to.device === deviceId && e.to.port === "sc");
  const chain = doc.channels[channelId]?.chain ?? [];
  const index = chain.indexOf(deviceId);

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
        minWidth: 150,
        opacity: device.enabled ? 1 : 0.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          data-testid={`device-enable-${deviceId}`}
          role="switch"
          aria-checked={device.enabled}
          title={device.enabled ? "Disable" : "Enable"}
          onClick={() => store.dispatch(commands.setDeviceEnabled(deviceId, !device.enabled))}
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            border: "1px solid #555",
            background: device.enabled ? "#7ad67a" : "#222",
            cursor: "pointer",
            padding: 0,
          }}
        />
        <span style={{ fontSize: 12, color: "#ddd", flex: 1 }}>{label}</span>
        {def !== undefined && (
          <>
            <select
              data-testid={`preset-select-${deviceId}`}
              aria-label="Preset"
              value=""
              onChange={(e) => {
                const preset = presetStore.list(def.id).find((entry) => entry.name === e.target.value);
                if (preset === undefined) return;
                // One undo entry for the whole bag (SS4 "presets are bags of
                // parameter values"); unknown/out-of-range ids are dropped.
                const values: Record<string, number> = {};
                for (const [localId, value] of Object.entries(preset.values)) {
                  if (def.params.some((p) => p.id === localId)) {
                    values[deviceParamId(channelId, deviceId, localId)] = value;
                  }
                }
                store.dispatch(commands.setParamValues(values));
              }}
              style={{ fontSize: 10, maxWidth: 90, background: "#181818", color: "#bbb" }}
            >
              <option value="">presets…</option>
              {presetStore.list(def.id).map((preset) => (
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
              }}
              style={tinyButton}
            >
              ⭳
            </button>
          </>
        )}
        {inChain && (
          <>
            <button
              type="button"
              data-testid={`device-left-${deviceId}`}
              title="Move earlier in the chain"
              disabled={index <= 0}
              onClick={() => store.dispatch(commands.moveDevice(channelId, deviceId, index - 1))}
              style={tinyButton}
            >
              ◀
            </button>
            <button
              type="button"
              data-testid={`device-right-${deviceId}`}
              title="Move later in the chain"
              disabled={index < 0 || index >= chain.length - 1}
              onClick={() => store.dispatch(commands.moveDevice(channelId, deviceId, index + 1))}
              style={tinyButton}
            >
              ▶
            </button>
            <button
              type="button"
              data-testid={`device-remove-${deviceId}`}
              title="Remove device"
              onClick={() => store.dispatch(commands.removeDevices([deviceId]))}
              style={tinyButton}
            >
              ✕
            </button>
          </>
        )}
      </div>

      {/* SS6 "Audio From" — the sidechain picker, exactly like Ableton's. */}
      {hasScPort && (
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "#888" }}>Audio From</span>
          <select
            data-testid={`sc-source-${deviceId}`}
            value={scEdge?.from.channel ?? ""}
            onChange={(e) => {
              const from = e.target.value;
              if (from === "") store.dispatch(commands.removeSidechain(deviceId, "sc"));
              else {
                const edge: SidechainEdge = {
                  from: { channel: from, tap: scEdge?.from.tap ?? "postFader" },
                  to: { device: deviceId, port: "sc" },
                };
                store.dispatch(commands.setSidechain(edge));
              }
            }}
            style={{ fontSize: 10, background: "#181818", color: "#bbb" }}
          >
            <option value="">None</option>
            {doc.channelOrder
              .filter((id) => id !== channelId)
              .map((id) => (
                <option key={id} value={id}>
                  {doc.channels[id]?.name ?? id}
                </option>
              ))}
          </select>
          {scEdge !== undefined && (
            <select
              data-testid={`sc-tap-${deviceId}`}
              value={scEdge.from.tap}
              onChange={(e) =>
                store.dispatch(
                  commands.setSidechain({
                    from: { channel: scEdge.from.channel, tap: e.target.value as SidechainEdge["from"]["tap"] },
                    to: { device: deviceId, port: "sc" },
                  }),
                )
              }
              style={{ fontSize: 10, background: "#181818", color: "#bbb" }}
            >
              <option value="preFx">Pre FX</option>
              <option value="postFx">Post FX</option>
              <option value="postFader">Post Fader</option>
            </select>
          )}
        </div>
      )}

      {/* Param rows (SS5): registry handles exist only once audio is up. */}
      {panel.rows.map((row, i) => (
        <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {row.controls.map((spec) => {
            const handle = engine?.params.get(deviceParamId(channelId, deviceId, spec.paramId));
            if (handle === undefined) {
              return (
                <span key={spec.paramId} style={{ fontSize: 10, color: "#444" }}>
                  {spec.paramId}
                </span>
              );
            }
            return <ParamControlFor key={spec.paramId} handle={handle} />;
          })}
        </div>
      ))}
    </div>
  );
}

export function DeviceChainPanel({ store, commands, engine, channelId }: DeviceChainPanelProps) {
  const [, force] = useState(0);
  useEffect(() => store.onChange(() => force((n) => n + 1)), [store]);
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
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
              store.dispatch(
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
              store={store}
              commands={commands}
              engine={engine}
              channelId={channel.id}
              deviceId={sourceDevice.id}
              inChain={false}
            />
          )}
        </div>
      )}

      {/* Effect chain, in order */}
      {channel.chain.map((deviceId) => (
        <DevicePanel
          key={deviceId}
          doc={doc}
          store={store}
          commands={commands}
          engine={engine}
          channelId={channel.id}
          deviceId={deviceId}
          inChain
        />
      ))}

      {/* Add-effect caret (SS7: "into a chain at a drop caret") */}
      <select
        data-testid="add-effect-select"
        aria-label="Add effect"
        value=""
        onChange={(e) => {
          const def = definitionsById.get(e.target.value);
          if (def !== undefined) {
            store.dispatch(commands.addEffect(channel.id, { definitionId: def.id, version: def.version }));
          }
        }}
        style={{ fontSize: 11, background: "#181818", color: "#bbb", alignSelf: "center" }}
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
    </div>
  );
}

const tinyButton: React.CSSProperties = {
  fontSize: 10,
  background: "#222",
  color: "#999",
  border: "1px solid #444",
  borderRadius: 3,
  cursor: "pointer",
  padding: "0 4px",
};
