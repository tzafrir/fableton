// SS7/SS5/SS6 — the selected channel's device chain.
//
// - Instrument slot (tracks): pick/replace the source instrument. The SS7
//   swap carries compatible params: the CALLER computes the carry map here
//   (it knows both definitions), the command applies it — clips untouched.
// - Note chain (tracks): the `midiEffect` devices that run BEFORE the
//   instrument — drawn first, because that is the order the notes travel in.
// - Effect chain: add (from the registry's `audioEffect` list), enable
//   toggle, reorder, remove. Every edit is one document command; the
//   reconciler turns it into a patch.
// - Panels: a definition with no `panel` gets the SS5 DEFAULT panel — every
//   descriptor as a control, kind -> control, four per row.
// - "Audio From" (SS6): rendered on any device whose definition declares an
//   `'sc'` input port; writes an explicit `SidechainEdge`.

import { useEffect, useMemo, useRef, useState } from "react";
import { CORE_DEVICES } from "../../devices/core";
import { FACTORY_RACKS } from "../../presets/factoryRacks";
import { presetStore } from "../../presets/store";
import { deviceParamId } from "../../params";
import { automatedParamIds } from "../../state";
import type { AppProjectEngine } from "../engine";
import type {
  ChannelId,
  Command,
  CommandResult,
  DeviceDefinition,
  DeviceInstanceId,
  DeviceReadoutSpec,
  DeviceSettingSpec,
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
import { Eq8Editor } from "./devices/Eq8Editor";
import { OperatorEditor } from "./devices/OperatorEditor";
import { WavetableEditor } from "./devices/WavetableEditor";
import { useDispatchHint } from "./useDispatchHint";

export interface DeviceChainPanelProps {
  store: DocumentStore;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  channelId: ChannelId | null;
  /** SS5's control context menu: "Show/create automation lane" — the shell
   *  creates (or re-enables) that param's lane and reveals it. */
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
  /** Switch which channel's chain is shown. Present when the panel is the
   *  whole view and therefore owes the user a way to change channels;
   *  omitted where something alongside already does that. */
  onSelectChannel?: ((channelId: ChannelId) => void) | undefined;
  /** Imports an audio file and returns its new `AssetId` (or `null` when it
   *  was rejected). Absent until audio is booted — decoding needs a context. */
  onImportSample?: ((file: File) => Promise<string | null>) | undefined;
}

/** Where a rendered device instance lives. */
export type DeviceContainer =
  | { kind: "source" }
  | { kind: "channel" }
  /** The channel's NOTE chain — devices that run before the instrument. */
  | { kind: "midiChain" }
  | { kind: "rackChain"; rackId: RackId; chainId: RackChainId };

const definitionsById = new Map(CORE_DEVICES.map((d) => [d.id, d]));
const instrumentDefs = CORE_DEVICES.filter((d) => d.kind === "instrument");
const effectDefs = CORE_DEVICES.filter((d) => d.kind === "audioEffect");
const noteEffectDefs = CORE_DEVICES.filter((d) => d.kind === "midiEffect");

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
  hasAutomation,
}: {
  handle: ParamHandle;
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
  hasAutomation?: boolean | undefined;
}) {
  const kind = controlKindFor(handle.desc);
  if (kind === "toggle") {
    // The LED alone is anonymous in a row of labelled knobs, so it carries
    // the same caption they do.
    return (
      <span className="fbl-toggle">
        <ToggleLED handle={handle} testId={`ctl-${handle.desc.id}`} />
        <span className="fbl-control-label">{handle.desc.label}</span>
      </span>
    );
  }
  if (kind === "enumSelect") return <EnumSelect handle={handle} testId={`ctl-${handle.desc.id}`} />;
  return (
    <Knob
      handle={handle}
      testId={`ctl-${handle.desc.id}`}
      onShowAutomation={
        onShowAutomation === undefined ? undefined : () => onShowAutomation(handle.desc.id)
      }
      hasAutomation={hasAutomation}
    />
  );
}

/**
 * One live device readout (SS5 `DeviceReadoutSpec`) as a meter.
 *
 * Polled at rAF straight off the engine, exactly like the SS6 strip meters,
 * and for the same reason: the value is UI-only and changes faster than the
 * document ever does, so pushing it through React state per report would be
 * a re-render per audio block. The bar is written with a direct style write
 * on a ref for the same reason — nothing above it re-renders at all.
 *
 * Gain reduction reads RIGHT-TO-LEFT, the way every hardware GR meter does:
 * a compressor at rest shows nothing, and the bar grows leftward from the
 * top of the scale as the device pulls the signal down.
 */
function ReadoutMeter({
  spec,
  engine,
  deviceId,
}: {
  spec: DeviceReadoutSpec;
  engine: AppProjectEngine | null;
  deviceId: DeviceInstanceId;
}) {
  const fillRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (engine === null) return;
    let raf = 0;
    let shown = -1;
    const span = Math.max(1e-6, spec.max - spec.min);
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const value = engine.deviceReadout(deviceId, spec.id);
      if (value === undefined) return;
      // A tenth of a dB is below what the eye resolves on a 60 px bar; not
      // repainting inside that keeps a quiet compressor completely idle.
      if (Math.abs(value - shown) < 0.05) return;
      shown = value;
      const fraction = Math.min(1, Math.max(0, (value - spec.min) / span));
      const fill = fillRef.current;
      if (fill !== null) fill.style.width = `${String(fraction * 100)}%`;
      const text = textRef.current;
      if (text !== null) {
        text.textContent = `${value < 0.05 ? "0" : `-${value.toFixed(1)}`}${spec.unit ?? ""}`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, deviceId, spec]);

  return (
    <div className="fbl-readout" data-testid={`readout-${deviceId}-${spec.id}`}>
      <span className="fbl-readout-label">{spec.label}</span>
      <div className="fbl-readout-track" title={`${spec.label}: 0 to ${String(spec.max)}${spec.unit ?? ""}`}>
        <div ref={fillRef} className="fbl-readout-fill" style={{ width: "0%" }} />
      </div>
      <span ref={textRef} className="fbl-readout-value">
        0{spec.unit ?? ""}
      </span>
    </div>
  );
}

/**
 * A device's sample slot (SS7 `DeviceSettingSpec` of kind `audioAsset`).
 *
 * Two ways in, because there are two situations: pick a file the project has
 * already imported, or import a new one. The picker is the primary control —
 * once a session has a few samples, choosing one should not mean going back
 * to the file system — and "Load…" sits beside it.
 */
function SampleSlot({
  spec,
  doc,
  dispatch,
  commands,
  deviceId,
  onImportSample,
}: {
  spec: DeviceSettingSpec;
  doc: ProjectSnapshot;
  dispatch: (command: Command) => CommandResult;
  commands: ProjectCommands;
  deviceId: DeviceInstanceId;
  onImportSample?: ((file: File) => Promise<string | null>) | undefined;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const current = doc.devices[deviceId]?.settings?.[spec.key] ?? "";
  const assets = Object.values(doc.assets).sort((a, b) => a.name.localeCompare(b.name));
  /** A setting pointing at an asset the project no longer has — a removed
   *  sample, or a project file opened without its bytes. Worth SAYING, since
   *  the symptom is otherwise an instrument that is silently mute. */
  const dangling = current !== "" && !assets.some((asset) => asset.id === current);

  const choose = (assetId: string): void => {
    dispatch(commands.setDeviceSetting(deviceId, spec.key, assetId === "" ? null : assetId));
  };

  return (
    <div className="fbl-param-row" data-testid={`setting-${deviceId}-${spec.key}`}>
      <span className="fbl-param-row-label">{spec.label}</span>
      <select
        className="fbl-field fbl-field--sm"
        value={dangling ? "" : current}
        data-testid={`sample-select-${deviceId}`}
        data-missing={dangling}
        onChange={(event) => choose(event.target.value)}
        title={dangling ? "This sample is no longer in the project" : "Choose an imported sample"}
      >
        <option value="">{dangling ? "Sample missing" : "No sample"}</option>
        {assets.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="fbl-btn fbl-btn--tiny"
        disabled={busy || onImportSample === undefined}
        data-testid={`sample-load-${deviceId}`}
        title={
          onImportSample === undefined
            ? "Boot audio before importing a sample — the file has to be decoded"
            : "Import an audio file from disk"
        }
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "Loading…" : "Load…"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        data-testid={`sample-file-${deviceId}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared immediately so picking the SAME file twice fires again —
          // a re-import after a failed one is the common case.
          event.target.value = "";
          if (file === undefined || onImportSample === undefined) return;
          setBusy(true);
          void onImportSample(file)
            .then((assetId) => {
              if (assetId !== null) choose(assetId);
            })
            .finally(() => setBusy(false));
        }}
      />
    </div>
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
  onImportSample,
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
  /** Imports an audio file and returns its new `AssetId` (or `null` when it
   *  was rejected). Absent until audio is booted — decoding needs a context. */
  onImportSample?: ((file: File) => Promise<string | null>) | undefined;
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
      : container.kind === "midiChain"
        ? (doc.channels[channelId]?.midiChain ?? [])
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
    // The chain scrolls horizontally, so a card keeps its size rather than
    // being squeezed by the ones after it (`.fbl-device` fixes min/max width
    // and `flex: 0 0 auto`) — a shrunk panel pushes its own controls outside
    // its own border, which is the overflow bug this layout exists to fix.
    <div
      className="fbl-device"
      data-testid={`device-${deviceId}`}
      data-enabled={device.enabled}
      // A device with its own editor gets a wider card: a curve squeezed into
      // the 250 px a knob grid needs is a curve you cannot aim at.
      data-editor={def?.editor}
    >
      {/* Header, in TWO rows on purpose. As one row it packed the enable
          dot, the title, the preset picker, save, and ◀ ▶ ✕ into a box whose
          `minWidth` is 150 — the row needs ~224px, so with a few effects in
          the chain the trailing buttons overflowed the panel's own border and
          landed on top of the NEXT device's title. Splitting the row keeps
          every control inside the box it belongs to. */}
      <div className="fbl-device-head">
        <button
          type="button"
          className="fbl-led"
          data-testid={`device-enable-${deviceId}`}
          data-on={device.enabled}
          role="switch"
          aria-checked={device.enabled}
          title={device.enabled ? "Disable" : "Enable"}
          onClick={() => dispatch(commands.setDeviceEnabled(deviceId, !device.enabled))}
        />
        {/* `.fbl-device-title` sets `min-width: 0`, which is what lets the
            name ellipsize instead of forcing the row wider than the card. */}
        <span className="fbl-device-title" title={label}>
          {label}
        </span>
        {inChain && (
          <button
            type="button"
            className="fbl-btn fbl-btn--tiny fbl-btn--ghost"
            data-testid={`device-remove-${deviceId}`}
            title="Remove device"
            onClick={() => dispatch(commands.removeDevices([deviceId]))}
          >
            ✕
          </button>
        )}
      </div>

      {(def !== undefined || inChain) && (
        <div className="fbl-device-row">
          {def !== undefined && (
            <>
              <select
                className="fbl-field fbl-field--sm"
                style={{ flex: 1, minWidth: 0 }}
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
                className="fbl-btn fbl-btn--tiny"
              >
                ⭳
              </button>
            </>
          )}
          {inChain && (
            <span style={{ display: "inline-flex", gap: 3, marginLeft: "auto" }}>
              {container.kind === "channel" && (
                <button
                  type="button"
                  data-testid={`device-group-${deviceId}`}
                  title="Group into a rack (parallel chains)"
                  onClick={() => dispatch(commands.groupIntoRack(channelId, [deviceId]))}
                  className="fbl-btn fbl-btn--tiny"
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
                className="fbl-btn fbl-btn--tiny"
              >
                ◀
              </button>
              <button
                type="button"
                data-testid={`device-right-${deviceId}`}
                title="Move later in the chain"
                disabled={index < 0 || index >= siblings.length - 1}
                onClick={() => moveTo(index + 1)}
                className="fbl-btn fbl-btn--tiny"
              >
                ▶
              </button>
            </span>
          )}
        </div>
      )}

      {/* SS6 "Audio From" — the sidechain picker, exactly like Ableton's. */}
      {hasScPort && (
        <div className="fbl-sc">
          <span className="fbl-sc-label">Audio From</span>
          <select
            className="fbl-field fbl-field--sm"
            style={{ flex: 1, maxWidth: 138 }}
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
              className="fbl-field fbl-field--sm"
              style={{ flex: 1, maxWidth: 138 }}
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

      {/* A device may bring its OWN panel (SS7 `DeviceDefinition.editor`) —
          the EQ, whose controls are a curve you drag rather than a row of
          knobs. It replaces the SS5 rows entirely, so an editor is
          responsible for every param the device declares. */}
      {def?.editor === "eq8" && (
        <Eq8Editor
          doc={doc}
          engine={engine}
          channelId={channelId}
          deviceId={deviceId}
          onShowAutomation={onShowAutomation}
        />
      )}

      {def?.editor === "operator" && (
        <OperatorEditor
          doc={doc}
          engine={engine}
          channelId={channelId}
          deviceId={deviceId}
          onShowAutomation={onShowAutomation}
        />
      )}

      {/* Param rows (SS5): registry handles exist only once audio is up. */}
      {def?.editor === "wavetable" && (
        <WavetableEditor
          doc={doc}
          engine={engine}
          channelId={channelId}
          deviceId={deviceId}
          onShowAutomation={onShowAutomation}
        />
      )}

      {def?.editor === undefined &&
        panel.rows.map((row, i) => (
          <div key={i} className="fbl-param-row">
            {/* SS5 panel rows may name themselves — the drum machine's do,
                one row per pad, and without this the eight pads' 24 knobs
                were an undifferentiated grid. */}
            {row.label !== undefined && <span className="fbl-param-row-label">{row.label}</span>}
            {row.controls.map((spec) => {
              const handle = engine?.params.get(deviceParamId(channelId, deviceId, spec.paramId));
              if (handle === undefined) {
                return (
                  <span key={spec.paramId} className="fbl-param-pending">
                    {spec.paramId}
                  </span>
                );
              }
              return (
                <ParamControlFor
                  key={spec.paramId}
                  handle={handle}
                  onShowAutomation={onShowAutomation}
                  hasAutomation={automatedParamIds(doc).has(handle.desc.id)}
                />
              );
            })}
          </div>
        ))}

      {/* Non-numeric settings (SS7 `DeviceSettingSpec`) — the sampler's file.
          Above the readouts and below the params, because it is an input. */}
      {def?.settings?.map((spec) => (
        <SampleSlot
          key={spec.key}
          spec={spec}
          doc={doc}
          dispatch={dispatch}
          commands={commands}
          deviceId={deviceId}
          onImportSample={onImportSample}
        />
      ))}

      {/* Live readouts (SS5 `DeviceReadoutSpec`): what the device is doing,
          under the params that told it to. */}
      {def?.readouts !== undefined && def.readouts.length > 0 && (
        <div className="fbl-readouts">
          {def.readouts.map((spec) => (
            <ReadoutMeter key={spec.id} spec={spec} engine={engine} deviceId={deviceId} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Every param of every device inside a rack, as macro targets. */
export function rackParamChoices(
  doc: ProjectSnapshot,
  rack: ProjectSnapshot["racks"][string],
): { paramId: ParamId; label: string; min: number; max: number }[] {
  const out: { paramId: ParamId; label: string; min: number; max: number }[] = [];
  for (const chain of rack.chains) {
    for (const deviceId of chain.devices) {
      const device = doc.devices[deviceId];
      const def = device === undefined ? undefined : definitionsById.get(device.definitionId);
      if (device === undefined || def === undefined) continue;
      for (const desc of def.params) {
        out.push({
          paramId: deviceParamId(rack.channelId, deviceId, desc.id),
          label: `${def.label} ${desc.label}`,
          min: desc.min,
          max: desc.max,
        });
      }
    }
  }
  return out;
}

/** A mapped target's short name, for the unmap chip. */
function labelForParam(doc: ProjectSnapshot, paramId: ParamId): string {
  const parsed = paramId.split("/");
  const local = parsed[parsed.length - 1] ?? paramId;
  const deviceSeg = parsed[1]?.replace("dev:", "") ?? "";
  const def = definitionsById.get(doc.devices[deviceSeg]?.definitionId ?? "");
  return def === undefined ? local : `${def.label} ${local}`;
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
  onImportSample,
}: {
  doc: ProjectSnapshot;
  dispatch: (command: Command) => CommandResult;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  channelId: ChannelId;
  rackId: RackId;
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
  /** Imports an audio file and returns its new `AssetId` (or `null` when it
   *  was rejected). Absent until audio is booted — decoding needs a context. */
  onImportSample?: ((file: File) => Promise<string | null>) | undefined;
}) {
  const rack = doc.racks[rackId];
  const slots = doc.channels[channelId]?.chain ?? [];
  const index = slots.indexOf(rackId);
  if (rack === undefined) return null;

  return (
    // Three levels of nesting (rack > chain > device) inside a strip that is
    // already dense: `.fbl-rack` carries the depth with an accent rail and a
    // darker ground rather than another border at every level.
    <div className="fbl-rack" data-testid={`rack-${rackId}`} data-enabled={rack.enabled}>
      <div className="fbl-device-head">
        <button
          type="button"
          className="fbl-led"
          data-testid={`rack-enable-${rackId}`}
          data-on={rack.enabled}
          role="switch"
          aria-checked={rack.enabled}
          title={rack.enabled ? "Disable rack" : "Enable rack"}
          onClick={() => dispatch(commands.setRackEnabled(rackId, !rack.enabled))}
        />
        <input
          className="fbl-rack-name"
          data-testid={`rack-name-${rackId}`}
          aria-label="Rack name"
          value={rack.name}
          onChange={(e) => dispatch(commands.renameRack(rackId, e.target.value))}
        />
        <button
          type="button"
          className="fbl-btn fbl-btn--tiny fbl-btn--ghost"
          data-testid={`rack-remove-${rackId}`}
          title="Remove rack and everything in it"
          onClick={() => dispatch(commands.removeDevices([rackId]))}
        >
          ✕
        </button>
      </div>

      <div className="fbl-device-row">
        <button
          type="button"
          data-testid={`rack-add-macro-${rackId}`}
          title="Add a macro knob"
          onClick={() => dispatch(commands.addMacro(rackId))}
          className="fbl-btn fbl-btn--tiny"
        >
          + Macro
        </button>
        <button
          type="button"
          data-testid={`rack-add-chain-${rackId}`}
          title="Add a parallel chain"
          onClick={() => dispatch(commands.addRackChain(rackId))}
          className="fbl-btn fbl-btn--tiny"
        >
          + Chain
        </button>
        <button
          type="button"
          data-testid={`rack-ungroup-${rackId}`}
          title="Dissolve the rack back into the channel chain"
          onClick={() => dispatch(commands.ungroupRack(rackId))}
          className="fbl-btn fbl-btn--tiny"
        >
          Ungroup
        </button>
        <span style={{ display: "inline-flex", gap: 3, marginLeft: "auto" }}>
          <button
            type="button"
            className="fbl-btn fbl-btn--tiny"
            data-testid={`rack-left-${rackId}`}
            title="Move earlier in the chain"
            disabled={index <= 0}
            onClick={() => dispatch(commands.moveDevice(channelId, rackId, index - 1))}
          >
            ◀
          </button>
          <button
            type="button"
            className="fbl-btn fbl-btn--tiny"
            data-testid={`rack-right-${rackId}`}
            title="Move later in the chain"
            disabled={index < 0 || index >= slots.length - 1}
            onClick={() => dispatch(commands.moveDevice(channelId, rackId, index + 1))}
          >
            ▶
          </button>
        </span>
      </div>

      {/* Macros (SS7): one knob fanned out to N params inside the rack. The
          target menu lists exactly the rack's own device params — a bounded,
          meaningful list, unlike "every param in the project". */}
      {rack.macros.length > 0 && (
        <div className="fbl-macros">
          {rack.macros.map((macro) => {
            const handle = engine?.params.get(macro.param);
            return (
              <div
                key={macro.id}
                className="fbl-macro"
                data-testid={`macro-${rackId}-${macro.id}`}
              >
                {handle === undefined ? (
                  <span className="fbl-param-pending">{macro.name}</span>
                ) : (
                  <Knob
                    handle={handle}
                    size={30}
                    label={macro.name}
                    testId={`macro-knob-${rackId}-${macro.id}`}
                    onShowAutomation={
                      onShowAutomation === undefined ? undefined : () => onShowAutomation(macro.param)
                    }
                  />
                )}
                <select
                  data-testid={`macro-map-${rackId}-${macro.id}`}
                  aria-label={`Map ${macro.name}`}
                  value=""
                  onChange={(e) => {
                    const target = rackParamChoices(doc, rack).find((c) => c.paramId === e.target.value);
                    if (target === undefined) return;
                    // A fresh mapping spans the target's whole range; the
                    // range is then editable by re-mapping (the command
                    // re-ranges rather than adding a second entry).
                    dispatch(
                      commands.mapMacro(rackId, macro.id, target.paramId, {
                        min: target.min,
                        max: target.max,
                      }),
                    );
                  }}
                  className="fbl-field fbl-field--sm"
                  style={{ maxWidth: 70, height: 16, fontSize: 9 }}
                >
                  <option value="" disabled>
                    map…
                  </option>
                  {rackParamChoices(doc, rack).map((choice) => (
                    <option key={choice.paramId} value={choice.paramId}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                {macro.targets.map((target) => (
                  <button
                    key={target.paramId}
                    type="button"
                    data-testid={`macro-unmap-${rackId}-${macro.id}`}
                    title={`Unmap ${target.paramId}`}
                    onClick={() => dispatch(commands.unmapMacro(rackId, macro.id, target.paramId))}
                    className="fbl-macro-target"
                  >
                    {labelForParam(doc, target.paramId)} ✕
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {rack.chains.map((chain) => {
        const gain = engine?.params.get(chain.gain);
        const pan = engine?.params.get(chain.pan);
        return (
          <div
            key={chain.id}
            className="fbl-rack-chain"
            data-testid={`chain-${rackId}-${chain.id}`}
            data-audible={!chain.mute || chain.solo}
          >
            <div className="fbl-device-row">
              <input
                className="fbl-chain-name"
                data-testid={`chain-name-${rackId}-${chain.id}`}
                aria-label="Chain name"
                value={chain.name}
                onChange={(e) => dispatch(commands.renameRackChain(rackId, chain.id, e.target.value))}
              />
              <button
                type="button"
                data-testid={`chain-mute-${rackId}-${chain.id}`}
                aria-pressed={chain.mute}
                title="Mute this chain"
                onClick={() => dispatch(commands.setChainMuted(rackId, chain.id, !chain.mute))}
                className="fbl-btn fbl-btn--tiny"
                data-on={chain.mute}
                data-tone="amber"
              >
                M
              </button>
              <button
                type="button"
                data-testid={`chain-solo-${rackId}-${chain.id}`}
                aria-pressed={chain.solo}
                title="Solo this chain (inside this rack only)"
                onClick={() => dispatch(commands.setChainSolo(rackId, chain.id, !chain.solo))}
                className="fbl-btn fbl-btn--tiny"
                data-on={chain.solo}
                data-tone="blue"
              >
                S
              </button>
              <button
                type="button"
                data-testid={`chain-remove-${rackId}-${chain.id}`}
                title="Remove this chain and its devices"
                onClick={() => dispatch(commands.removeRackChain(rackId, chain.id))}
                className="fbl-btn fbl-btn--tiny fbl-btn--ghost"
              >
                ✕
              </button>
            </div>

            <div className="fbl-param-row">
              {gain === undefined ? (
                <span className="fbl-param-pending">gain</span>
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
                <span className="fbl-param-pending">pan</span>
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

            <div className="fbl-chain-devices">
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
                  onImportSample={onImportSample}
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
                className="fbl-field fbl-field--sm"
                style={{ alignSelf: "center" }}
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

/** The channel picker above the chain — the Devices view's own half of the
 *  selection the mixer used to sit next to. Without it, changing which
 *  channel you are editing meant leaving the view entirely. */
function ChannelBar({
  doc,
  channelId,
  onSelectChannel,
}: {
  doc: ProjectSnapshot;
  channelId: ChannelId | null;
  onSelectChannel: (id: ChannelId) => void;
}) {
  return (
    <div className="fbl-pane-head fbl-channel-bar" data-testid="device-channel-bar">
      <span className="fbl-tb-label">Devices</span>
      {doc.channelOrder.map((id) => {
        const channel = doc.channels[id];
        if (channel === undefined) return null;
        return (
          <button
            key={id}
            type="button"
            className="fbl-channel-chip"
            data-testid={`device-channel-${id}`}
            data-role={channel.role}
            aria-pressed={id === channelId}
            onClick={() => onSelectChannel(id)}
          >
            {channel.name}
          </button>
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
  onSelectChannel,
  onShowAutomation,
  onImportSample,
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

  const bar =
    onSelectChannel === undefined ? null : (
      <ChannelBar doc={doc} channelId={channelId} onSelectChannel={onSelectChannel} />
    );

  if (channel === undefined) {
    return (
      <div className="fbl-devices-view">
        {bar}
        <div className="fbl-empty" data-testid="device-chain-panel">
          <strong>No channel selected</strong>
          Pick a channel above, or a track in the mixer or the arrangement, to see its
          instrument and effects.
        </div>
      </div>
    );
  }

  const sourceDevice = channel.source !== null ? doc.devices[channel.source.deviceId] : undefined;
  const sourceDef = sourceDevice !== undefined ? definitionsById.get(sourceDevice.definitionId) : undefined;

  return (
    <div className="fbl-devices-view">
      {bar}
      <div className="fbl-device-chain" data-testid="device-chain-panel">
      {/* Note effects (SS7 `midiEffect`), tracks only — drawn BEFORE the
          instrument because that is the order the notes travel in. */}
      {channel.role === "track" && (
        <div className="fbl-note-chain" data-testid="note-chain">
          <span className="fbl-note-chain-label">MIDI</span>
          {(channel.midiChain ?? []).map((deviceId) => (
            <DevicePanel
              key={deviceId}
              doc={doc}
              dispatch={dispatch}
              commands={commands}
              engine={engine}
              channelId={channel.id}
              deviceId={deviceId}
              container={{ kind: "midiChain" }}
              onShowAutomation={onShowAutomation}
              onImportSample={onImportSample}
            />
          ))}
          <select
            className="fbl-field"
            style={{ alignSelf: "flex-start", flex: "0 0 auto" }}
            data-testid="add-note-effect-select"
            aria-label="Add note effect"
            value=""
            onChange={(e) => {
              const def = definitionsById.get(e.target.value);
              if (def !== undefined) {
                dispatch(
                  commands.addNoteEffect(channel.id, {
                    definitionId: def.id,
                    version: def.version,
                  }),
                );
              }
            }}
          >
            <option value="" disabled>
              + MIDI effect…
            </option>
            {noteEffectDefs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Instrument slot (tracks only, SS7) */}
      {channel.role === "track" && (
        <div className="fbl-slot">
          <select
            className="fbl-field"
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
              onImportSample={onImportSample}
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
            onImportSample={onImportSample}
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
            onImportSample={onImportSample}
          />
        ),
      )}

      {/* Add-effect caret (SS7: "into a chain at a drop caret") */}
      <select
        className="fbl-field"
        style={{ alignSelf: "flex-start", marginTop: 4, flex: "0 0 auto" }}
        data-testid="add-effect-select"
        aria-label="Add effect"
        value=""
        onChange={(e) => {
          const def = definitionsById.get(e.target.value);
          if (def !== undefined) {
            dispatch(commands.addEffect(channel.id, { definitionId: def.id, version: def.version }));
          }
        }}
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

      {/* Factory racks: a whole patch (chains, devices, routing) as one
          undoable command. `Gated Reverb` is the one the racks plan aimed at. */}
      <select
        className="fbl-field"
        style={{ alignSelf: "flex-start", marginTop: 4, flex: "0 0 auto" }}
        data-testid="add-factory-rack"
        aria-label="Add a factory rack"
        value=""
        onChange={(e) => {
          const preset = FACTORY_RACKS.find((rack) => rack.name === e.target.value);
          if (preset !== undefined) dispatch(commands.addRackPreset(channel.id, preset));
        }}
      >
        <option value="" disabled>
          + Rack preset…
        </option>
        {FACTORY_RACKS.map((rack) => (
          <option key={rack.name} value={rack.name}>
            {rack.name}
          </option>
        ))}
      </select>

      <button
        type="button"
        data-testid="add-rack-button"
        title="Add an empty rack (parallel chains)"
        onClick={() => dispatch(commands.addRack(channel.id))}
        className="fbl-btn"
        style={{ alignSelf: "flex-start", marginTop: 4, flex: "0 0 auto" }}
      >
        + Rack
      </button>

      {/* SS6: a rejected edit (a sidechain that would close a cycle) says so
          inline instead of looking like nothing happened. */}
      {hint !== null && (
        <span className="fbl-hint" data-testid="device-chain-hint" role="status" style={{ alignSelf: "flex-start", marginTop: 8 }}>
          {hint}
        </span>
      )}
      </div>
    </div>
  );
}
