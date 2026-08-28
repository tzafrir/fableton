// SS6/SS18-M2 — the mixer: one strip per channel (identical strip code for
// tracks, groups, returns and the master — SS6's whole point), sends, output
// routing ("Audio To"), solo/mute, and the SS6 meter fed at rAF.
//
// Bounded-count DOM (SS15): strips are React, values go through the SS5
// control kit, structure edits go through `ProjectCommands`. Param controls
// bind registry handles from the ENGINE — before audio boots there is no
// registry, so faders render as placeholders while every document-side verb
// (mute/solo/routing/sends) still works.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppProjectEngine,
} from "../engine";
import type {
  ChannelId,
  Command,
  CommandResult,
  DocumentStore,
  ParamId,
  ProjectCommands,
  ProjectSnapshot,
} from "../../types";
import type { Immutable, Channel } from "../../types";
import { automatedParamIds } from "../../state";
import { Fader, Knob } from "../../ui/controls";
import { SIGNAL } from "../../ui/theme";
import { useDispatchHint } from "./useDispatchHint";

export interface MixerPanelProps {
  store: DocumentStore;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  selectedChannelId: ChannelId | null;
  onSelectChannel: (channelId: ChannelId) => void;
  /** SS5's control context menu: "Show/create automation lane". The shell
   *  creates (or re-enables) the lane for that param and reveals it — this
   *  is what makes the menu row more than decoration. */
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
  /** Reveal a channel's device chain. The mixer and the chain are separate
   *  full-width views, so this is the bridge between them. */
  onOpenDevices?: ((channelId: ChannelId) => void) | undefined;
}

type RChannel = Immutable<Channel>;

/** Eligible "Audio To" targets: groups + the master, minus anything that
 *  would obviously self-reference. The command's canRun still runs the real
 *  cycle check — this list is just the sensible menu. */
function outputTargets(doc: ProjectSnapshot, channel: RChannel): RChannel[] {
  return doc.channelOrder
    .map((id) => doc.channels[id])
    .filter((c): c is RChannel => c !== undefined)
    .filter((c) => (c.role === "group" || c.role === "master") && c.id !== channel.id);
}

function returnsOf(doc: ProjectSnapshot): RChannel[] {
  return doc.channelOrder
    .map((id) => doc.channels[id])
    .filter((c): c is RChannel => c !== undefined && c.role === "return");
}

/** The SS6 meter, read at rAF from the engine's meter bus. */
function MeterBar({ engine, channelId }: { engine: AppProjectEngine | null; channelId: ChannelId }) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (engine === null) return;
    let raf = 0;
    const paint = (): void => {
      const el = canvasRef.current;
      if (el !== null) {
        const frame = engine.meters.frame(channelId);
        const peak = Math.min(1, frame?.peak ?? 0);
        const rms = Math.min(1, frame?.rms ?? 0);
        const bar = el.firstElementChild as HTMLElement | null;
        const dot = el.lastElementChild as HTMLElement | null;
        if (bar !== null) bar.style.height = `${(rms * 100).toFixed(1)}%`;
        if (dot !== null) dot.style.bottom = `${(peak * 100).toFixed(1)}%`;
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [engine, channelId]);

  // Structure is load-bearing: the FIRST child is the rms bar (its inline
  // height is the level), the LAST is the peak line. Both are written from
  // the rAF loop above, so neither can be a styled pseudo-element.
  return (
    <div ref={canvasRef} className="fbl-meter" data-testid={`meter-${channelId}`}>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "0%",
          background: `linear-gradient(to top, ${SIGNAL.green} 0%, ${SIGNAL.green} 62%, ${SIGNAL.amber} 86%, ${SIGNAL.coral} 100%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: "0%",
          left: 0,
          right: 0,
          height: 1,
          background: "#ffffff",
          boxShadow: "0 0 4px rgba(255,255,255,0.6)",
        }}
      />
    </div>
  );
}

function Strip({
  doc,
  channel,
  dispatch,
  commands,
  engine,
  selected,
  onSelect,
  onShowAutomation,
  onOpenDevices,
}: {
  doc: ProjectSnapshot;
  channel: RChannel;
  /** The panel's rejection-aware dispatch (SS6 inline hint), not
   *  `store.dispatch` — see `useDispatchHint`. */
  dispatch: (command: Command) => CommandResult;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  selected: boolean;
  onSelect: (id: ChannelId) => void;
  onShowAutomation?: ((paramId: ParamId) => void) | undefined;
  /** Jump to this channel's device chain. Absent while the mixer is shown
   *  somewhere there is no chain view to jump to. */
  onOpenDevices?: ((id: ChannelId) => void) | undefined;
}) {
  /** SS5 menu row -> the shell's lane reveal, or absent (row hidden). */
  const showAutomation = (paramId: ParamId): (() => void) | undefined =>
    onShowAutomation === undefined ? undefined : () => onShowAutomation(paramId);
  /** Whether that row should say `Show` or `Add`. */
  const automated = automatedParamIds(doc);
  const volume = engine?.params.get(channel.volume);
  const pan = engine?.params.get(channel.pan);
  const returns = returnsOf(doc);
  // A return may feed another return, but never itself — `setSend`'s canRun
  // rejects a self-send, so rendering the control made a button that did
  // nothing when clicked.
  const sendTargets = returns.filter((ret) => ret.id !== channel.id);
  const targets = outputTargets(doc, channel);

  /** Everything mounted on the channel, in all three chains — the number the
   *  strip's device button shows. */
  const deviceCount =
    (channel.source === null ? 0 : 1) + channel.chain.length + (channel.midiChain?.length ?? 0);

  const [renaming, setRenaming] = useState(false);
  // Unmounting the input fires `blur`, so Escape would otherwise commit the
  // very text it just discarded. A REF, not the state: the blur handler still
  // closes over the render in which `renaming` was true. (Same latch the
  // arrangement header's rename needed, for the same reason.)
  const abandoned = useRef(false);
  const commitRename = (raw: string): void => {
    if (abandoned.current) {
      abandoned.current = false;
      return;
    }
    setRenaming(false);
    const next = raw.trim();
    if (next.length > 0 && next !== channel.name) {
      dispatch(commands.renameChannel(channel.id, next));
    }
  };

  // A strip's own colour if it has one, else the role's. The rule under the
  // name is the only place a channel's identity is stated in the mixer, so
  // it always says something.
  const roleColor =
    channel.color ??
    (channel.role === "master"
      ? SIGNAL.green
      : channel.role === "group"
        ? SIGNAL.amber
        : channel.role === "return"
          ? SIGNAL.blue
          : "#4b5468");

  return (
    <div
      className="fbl-strip"
      data-testid={`strip-${channel.id}`}
      data-role={channel.role}
      data-selected={selected}
      onPointerDown={() => onSelect(channel.id)}
    >
      {/* Double-click to rename, the same gesture the arrangement header
          uses. Renaming existed only there, which is the wrong half of the
          app to look in when you are mixing. */}
      {renaming ? (
        <input
          data-testid={`strip-rename-${channel.id}`}
          aria-label={`Rename ${channel.name}`}
          defaultValue={channel.name}
          autoFocus
          onBlur={(e) => commitRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            // Escape must ABANDON: clearing the flag first means the blur
            // that `remove` triggers cannot commit the discarded text.
            if (e.key === "Escape") {
              abandoned.current = true;
              setRenaming(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="fbl-field fbl-field--sm"
          style={{ width: 80, textAlign: "center" }}
        />
      ) : (
        <span
          className="fbl-strip-name"
          data-testid={`strip-name-${channel.id}`}
          onDoubleClick={() => setRenaming(true)}
          style={{ borderBottomColor: roleColor }}
          title={`${channel.name} (${channel.role}) — double-click to rename`}
        >
          {channel.name}
        </span>
      )}

      {/* The strip's link to its chain. The mixer and the device view are
          separate full-width tabs now, so each strip has to say what is ON
          it and offer the one click that goes there — otherwise selecting a
          channel here and finding its devices are two unrelated motions. */}
      {onOpenDevices !== undefined && (
        <button
          type="button"
          className="fbl-strip-devices"
          data-testid={`strip-devices-${channel.id}`}
          data-empty={deviceCount === 0}
          title={`Open ${channel.name}'s devices`}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(channel.id);
            onOpenDevices(channel.id);
          }}
        >
          {deviceCount === 0 ? "no devices" : `${String(deviceCount)} device${deviceCount === 1 ? "" : "s"}`}
        </button>
      )}

      {/* sends — one slim knob per return (SS6) */}
      {channel.role !== "master" && sendTargets.length > 0 && (
        <div className="fbl-strip-sends" data-testid={`sends-${channel.id}`}>
          {sendTargets.map((ret) => {
            const send = channel.sends.find((s) => s.to === ret.id);
            const handle = send !== undefined ? engine?.params.get(send.amount) : undefined;
            if (send !== undefined && handle !== undefined) {
              return (
                <span key={ret.id} className="fbl-send">
                  <Knob
                    handle={handle}
                    size={26}
                    label={ret.name.replace("Return ", "")}
                    testId={`send-${channel.id}-${ret.id}`}
                    onShowAutomation={showAutomation(send.amount)}
                    hasAutomation={automated.has(send.amount)}
                  />
                  {/* SS6: "send taps at pre-fader (post-chain) or post-fader".
                      The tap has been in the document and honoured by the
                      graph since M2 — this is the control that reaches it. */}
                  <button
                    type="button"
                    data-testid={`send-tap-${channel.id}-${ret.id}`}
                    aria-label={`Send to ${ret.name}: ${send.tap === "pre" ? "pre" : "post"}-fader`}
                    title={
                      send.tap === "pre"
                        ? "Pre-fader: the send ignores this channel's fader (still muted by M)"
                        : "Post-fader: the send follows this channel's fader"
                    }
                    onClick={() => dispatch(commands.setSend(channel.id, ret.id, send.tap === "pre" ? "post" : "pre"))}
                    className="fbl-tap"
                    data-on={send.tap === "pre"}
                  >
                    {send.tap === "pre" ? "PRE" : "POST"}
                  </button>
                </span>
              );
            }
            if (send !== undefined) {
              // The send EXISTS in the document; its handle arrives when
              // audio boots. A placeholder, not the add stub.
              return (
                <div
                  key={ret.id}
                  data-testid={`send-pending-${channel.id}-${ret.id}`}
                  title={`Send to ${ret.name} (boot audio to adjust)`}
                  className="fbl-send-stub"
                  data-pending="true"
                >
                  {ret.name.replace("Return ", "")}
                </div>
              );
            }
            return (
              <button
                key={ret.id}
                type="button"
                data-testid={`add-send-${channel.id}-${ret.id}`}
                title={`Send to ${ret.name}`}
                onClick={() => dispatch(commands.setSend(channel.id, ret.id))}
                className="fbl-send-stub"
              >
                {ret.name.replace("Return ", "")}
              </button>
            );
          })}
        </div>
      )}

      <div className="fbl-fader-row">
        {volume !== undefined ? (
          <Fader
            handle={volume}
            testId={`vol-${channel.id}`}
            onShowAutomation={showAutomation(channel.volume)}
            hasAutomation={automated.has(channel.volume)}
          />
        ) : (
          <div className="fbl-fader-placeholder">—</div>
        )}
        <MeterBar engine={engine} channelId={channel.id} />
      </div>

      {pan !== undefined ? (
        <Knob
          handle={pan}
          size={28}
          label="Pan"
          testId={`pan-${channel.id}`}
          onShowAutomation={showAutomation(channel.pan)}
          hasAutomation={automated.has(channel.pan)}
        />
      ) : (
        <div style={{ height: 40 }} />
      )}

      <div className="fbl-ms">
        {channel.role !== "master" && (
          <>
            <button
              type="button"
              data-testid={`mute-${channel.id}`}
              aria-pressed={channel.mute}
              title="Mute"
              onClick={() => dispatch(commands.setChannelMuted(channel.id, !channel.mute))}
              className="fbl-btn"
              data-on={channel.mute}
              data-tone="amber"
            >
              M
            </button>
            <button
              type="button"
              data-testid={`solo-${channel.id}`}
              aria-pressed={channel.solo}
              title="Solo (in place)"
              onClick={() => dispatch(commands.setChannelSolo(channel.id, !channel.solo))}
              className="fbl-btn"
              data-on={channel.solo}
              data-tone="blue"
            >
              S
            </button>
          </>
        )}
      </div>

      {/* Audio To (SS6: moving a track into a group is a one-field edit) */}
      {channel.role !== "master" ? (
        <span className="fbl-strip-out">
          <span className="fbl-unit" title="Audio To" aria-hidden="true">
            →
          </span>
          <select
            className="fbl-field fbl-field--sm"
            data-testid={`output-${channel.id}`}
            aria-label={`${channel.name} output`}
            value={channel.output ?? ""}
            onChange={(e) => dispatch(commands.setChannelOutput(channel.id, e.target.value))}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </span>
      ) : (
        <span className="fbl-strip-role" style={{ marginTop: "auto", paddingTop: 4 }}>
          Master
        </span>
      )}
    </div>
  );
}

export function MixerPanel({
  store,
  commands,
  engine,
  selectedChannelId,
  onSelectChannel,
  onShowAutomation,
  onOpenDevices,
}: MixerPanelProps) {
  const doc = store.getState();
  const [, force] = useState(0);
  useEffect(() => store.onChange(() => force((n) => n + 1)), [store]);
  // Handles are read during render (`engine.params.get`) but are registered
  // ASYNCHRONOUSLY — `host.mount` awaits `prepare()`, and the reconciler syncs
  // mixer params after `await applyPatch`, i.e. long after React flushed the
  // render for the document change that added the channel. Without this
  // subscription a new track/return/send shows the `—` fader and the greyed
  // send circle until some UNRELATED edit re-renders the panel (SS4/SS6).
  useEffect(() => {
    if (engine === null) return;
    return engine.params.onRegistryChange(() => force((n) => n + 1));
  }, [engine]);
  const { hint, dispatch } = useDispatchHint(store);

  const selection = selectedChannelId !== null && doc.channels[selectedChannelId] !== undefined
    ? [selectedChannelId]
    : [];

  const addReturn = useCallback(() => {
    dispatch(commands.addReturn());
  }, [dispatch, commands]);

  const groupSelected = useCallback(() => {
    if (selection.length > 0) dispatch(commands.addGroup(selection));
  }, [dispatch, commands, selection]);

  const deleteSelected = useCallback(() => {
    if (selection.length > 0) dispatch(commands.deleteChannels(selection));
  }, [dispatch, commands, selection]);

  return (
    <div className="fbl-mixer" data-testid="mixer-panel">
      <div className="fbl-pane-head">
        <span className="fbl-tb-label">Mixer</span>
        <button
          type="button"
          data-testid="add-track-button"
          onClick={() => dispatch(commands.addTrack())}
          className="fbl-btn"
        >
          + Track
        </button>
        <button type="button" data-testid="add-return-button" onClick={addReturn} className="fbl-btn">
          + Return
        </button>
        <button
          type="button"
          data-testid="group-selected-button"
          onClick={groupSelected}
          disabled={selection.length === 0}
          className="fbl-btn"
          title="Group the selected channel"
        >
          Group
        </button>
        <button
          type="button"
          data-testid="delete-channel-button"
          onClick={deleteSelected}
          disabled={selection.length === 0 || selection.some((id) => doc.channels[id]?.role === "master")}
          className="fbl-btn"
          title="Delete the selected channel"
        >
          Delete
        </button>
        {/* SS6: "cycle-forming edits are rejected with an inline hint" — the
            Audio To picker, Group and Delete all land here. */}
        {hint !== null && (
          <span className="fbl-hint" data-testid="mixer-hint" role="status">
            {hint}
          </span>
        )}
      </div>
      <div className="fbl-mixer-strips">
        {doc.channelOrder.map((id) => {
          const channel = doc.channels[id];
          if (channel === undefined) return null;
          return (
            <Strip
              key={id}
              doc={doc}
              channel={channel}
              dispatch={dispatch}
              commands={commands}
              engine={engine}
              selected={selectedChannelId === id}
              onSelect={onSelectChannel}
              onShowAutomation={onShowAutomation}
              onOpenDevices={onOpenDevices}
            />
          );
        })}
      </div>
    </div>
  );
}
