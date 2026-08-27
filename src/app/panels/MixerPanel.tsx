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
import { Fader, Knob } from "../../ui/controls";
import { rejectionHintStyle, useDispatchHint } from "./useDispatchHint";

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

  return (
    <div
      ref={canvasRef}
      className="fbl-meter"
      data-testid={`meter-${channelId}`}
      style={{
        position: "relative",
        width: 6,
        height: 96,
        background: "#191919",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "0%",
          background: "linear-gradient(to top, #4caf50, #ffc107 85%, #f44336)",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: "0%",
          left: 0,
          right: 0,
          height: 1,
          background: "#fff",
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
}) {
  /** SS5 menu row -> the shell's lane reveal, or absent (row hidden). */
  const showAutomation = (paramId: ParamId): (() => void) | undefined =>
    onShowAutomation === undefined ? undefined : () => onShowAutomation(paramId);
  const volume = engine?.params.get(channel.volume);
  const pan = engine?.params.get(channel.pan);
  const returns = returnsOf(doc);
  // A return may feed another return, but never itself — `setSend`'s canRun
  // rejects a self-send, so rendering the control made a button that did
  // nothing when clicked.
  const sendTargets = returns.filter((ret) => ret.id !== channel.id);
  const targets = outputTargets(doc, channel);

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

  const roleColor =
    channel.role === "master" ? "#7a5" : channel.role === "group" ? "#a97" : channel.role === "return" ? "#79a" : "#888";

  return (
    <div
      className="fbl-strip"
      data-testid={`strip-${channel.id}`}
      data-role={channel.role}
      onPointerDown={() => onSelect(channel.id)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        padding: "6px 4px",
        minWidth: 84,
        borderRight: "1px solid #292929",
        background: selected ? "#20242c" : "transparent",
      }}
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
          style={{
            fontSize: 11,
            width: 78,
            background: "#181818",
            color: "#ddd",
            border: "1px solid #555",
            borderRadius: 2,
          }}
        />
      ) : (
        <span
          data-testid={`strip-name-${channel.id}`}
          onDoubleClick={() => setRenaming(true)}
          style={{
            fontSize: 11,
            color: channel.color ?? "#ddd",
            borderBottom: `2px solid ${roleColor}`,
            maxWidth: 80,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: "text",
          }}
          title={`${channel.name} (${channel.role}) — double-click to rename`}
        >
          {channel.name}
        </span>
      )}

      {/* sends — one slim knob per return (SS6) */}
      {channel.role !== "master" && sendTargets.length > 0 && (
        <div style={{ display: "flex", gap: 2 }} data-testid={`sends-${channel.id}`}>
          {sendTargets.map((ret) => {
            const send = channel.sends.find((s) => s.to === ret.id);
            const handle = send !== undefined ? engine?.params.get(send.amount) : undefined;
            if (send !== undefined && handle !== undefined) {
              return (
                <span key={ret.id} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
                  <Knob
                    handle={handle}
                    size={26}
                    label={ret.name.replace("Return ", "")}
                    testId={`send-${channel.id}-${ret.id}`}
                    onShowAutomation={showAutomation(send.amount)}
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
                    style={{
                      marginTop: 1,
                      fontSize: 8,
                      lineHeight: 1.4,
                      padding: "0 4px",
                      background: send.tap === "pre" ? "#3a5a7a" : "#222",
                      color: send.tap === "pre" ? "#cfe6ff" : "#888",
                      border: "1px solid #444",
                      borderRadius: 2,
                      cursor: "pointer",
                    }}
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
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    border: "1px solid #444",
                    display: "grid",
                    placeItems: "center",
                    color: "#666",
                    fontSize: 10,
                  }}
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
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  border: "1px dashed #444",
                  background: "none",
                  color: "#555",
                  fontSize: 10,
                  cursor: "pointer",
                }}
              >
                {ret.name.replace("Return ", "")}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "flex-end", gap: 4 }}>
        {volume !== undefined ? (
          <Fader
            handle={volume}
            testId={`vol-${channel.id}`}
            onShowAutomation={showAutomation(channel.volume)}
          />
        ) : (
          <div style={{ width: 28, height: 106, display: "grid", placeItems: "center", color: "#444", fontSize: 10 }}>
            —
          </div>
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
        />
      ) : (
        <div style={{ height: 40 }} />
      )}

      <div style={{ display: "flex", gap: 3 }}>
        {channel.role !== "master" && (
          <>
            <button
              type="button"
              data-testid={`mute-${channel.id}`}
              aria-pressed={channel.mute}
              title="Mute"
              onClick={() => dispatch(commands.setChannelMuted(channel.id, !channel.mute))}
              style={{
                width: 22,
                fontSize: 10,
                background: channel.mute ? "#c58f00" : "#222",
                color: channel.mute ? "#000" : "#aaa",
                border: "1px solid #444",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              M
            </button>
            <button
              type="button"
              data-testid={`solo-${channel.id}`}
              aria-pressed={channel.solo}
              title="Solo (in place)"
              onClick={() => dispatch(commands.setChannelSolo(channel.id, !channel.solo))}
              style={{
                width: 22,
                fontSize: 10,
                background: channel.solo ? "#2d7ff0" : "#222",
                color: channel.solo ? "#fff" : "#aaa",
                border: "1px solid #444",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              S
            </button>
          </>
        )}
      </div>

      {/* Audio To (SS6: moving a track into a group is a one-field edit) */}
      {channel.role !== "master" && (
        <select
          data-testid={`output-${channel.id}`}
          aria-label={`${channel.name} output`}
          value={channel.output ?? ""}
          onChange={(e) => dispatch(commands.setChannelOutput(channel.id, e.target.value))}
          style={{ fontSize: 10, maxWidth: 78, background: "#181818", color: "#bbb" }}
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
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
    <div
      className="fbl-mixer"
      data-testid="mixer-panel"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div style={{ display: "flex", gap: 6, padding: "4px 8px", borderBottom: "1px solid #292929" }}>
        <button
          type="button"
          data-testid="add-track-button"
          onClick={() => dispatch(commands.addTrack())}
          style={miniButton}
        >
          + Track
        </button>
        <button type="button" data-testid="add-return-button" onClick={addReturn} style={miniButton}>
          + Return
        </button>
        <button
          type="button"
          data-testid="group-selected-button"
          onClick={groupSelected}
          disabled={selection.length === 0}
          style={miniButton}
          title="Group the selected channel"
        >
          Group
        </button>
        <button
          type="button"
          data-testid="delete-channel-button"
          onClick={deleteSelected}
          disabled={selection.length === 0 || selection.some((id) => doc.channels[id]?.role === "master")}
          style={miniButton}
          title="Delete the selected channel"
        >
          Delete
        </button>
        {/* SS6: "cycle-forming edits are rejected with an inline hint" — the
            Audio To picker, Group and Delete all land here. */}
        {hint !== null && (
          <span data-testid="mixer-hint" role="status" style={rejectionHintStyle}>
            {hint}
          </span>
        )}
      </div>
      <div style={{ display: "flex", overflowX: "auto", flex: 1, minHeight: 0 }}>
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
            />
          );
        })}
      </div>
    </div>
  );
}

const miniButton: React.CSSProperties = {
  fontSize: 11,
  background: "#222",
  color: "#bbb",
  border: "1px solid #444",
  borderRadius: 3,
  padding: "2px 8px",
  cursor: "pointer",
};
