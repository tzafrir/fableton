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
  DocumentStore,
  ProjectCommands,
  ProjectSnapshot,
} from "../../types";
import type { Immutable, Channel } from "../../types";
import { Fader, Knob } from "../../ui/controls";

export interface MixerPanelProps {
  store: DocumentStore;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  selectedChannelId: ChannelId | null;
  onSelectChannel: (channelId: ChannelId) => void;
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
  store,
  commands,
  engine,
  selected,
  onSelect,
}: {
  doc: ProjectSnapshot;
  channel: RChannel;
  store: DocumentStore;
  commands: ProjectCommands;
  engine: AppProjectEngine | null;
  selected: boolean;
  onSelect: (id: ChannelId) => void;
}) {
  const volume = engine?.params.get(channel.volume);
  const pan = engine?.params.get(channel.pan);
  const returns = returnsOf(doc);
  const targets = outputTargets(doc, channel);

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
      <span
        data-testid={`strip-name-${channel.id}`}
        style={{
          fontSize: 11,
          color: channel.color ?? "#ddd",
          borderBottom: `2px solid ${roleColor}`,
          maxWidth: 80,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={`${channel.name} (${channel.role})`}
      >
        {channel.name}
      </span>

      {/* sends — one slim knob per return (SS6) */}
      {channel.role !== "master" && returns.length > 0 && (
        <div style={{ display: "flex", gap: 2 }} data-testid={`sends-${channel.id}`}>
          {returns.map((ret) => {
            const send = channel.sends.find((s) => s.to === ret.id);
            const handle = send !== undefined ? engine?.params.get(send.amount) : undefined;
            if (send !== undefined && handle !== undefined) {
              return <Knob key={ret.id} handle={handle} size={26} label={ret.name.replace("Return ", "")} testId={`send-${channel.id}-${ret.id}`} />;
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
                onClick={() => store.dispatch(commands.setSend(channel.id, ret.id))}
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
          <Fader handle={volume} testId={`vol-${channel.id}`} />
        ) : (
          <div style={{ width: 28, height: 106, display: "grid", placeItems: "center", color: "#444", fontSize: 10 }}>
            —
          </div>
        )}
        <MeterBar engine={engine} channelId={channel.id} />
      </div>

      {pan !== undefined ? (
        <Knob handle={pan} size={28} label="Pan" testId={`pan-${channel.id}`} />
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
              onClick={() => store.dispatch(commands.setChannelMuted(channel.id, !channel.mute))}
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
              onClick={() => store.dispatch(commands.setChannelSolo(channel.id, !channel.solo))}
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
          onChange={(e) => store.dispatch(commands.setChannelOutput(channel.id, e.target.value))}
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

export function MixerPanel({ store, commands, engine, selectedChannelId, onSelectChannel }: MixerPanelProps) {
  const doc = store.getState();
  const [, force] = useState(0);
  useEffect(() => store.onChange(() => force((n) => n + 1)), [store]);

  const selection = selectedChannelId !== null && doc.channels[selectedChannelId] !== undefined
    ? [selectedChannelId]
    : [];

  const addReturn = useCallback(() => {
    store.dispatch(commands.addReturn());
  }, [store, commands]);

  const groupSelected = useCallback(() => {
    if (selection.length > 0) store.dispatch(commands.addGroup(selection));
  }, [store, commands, selection]);

  const deleteSelected = useCallback(() => {
    if (selection.length > 0) store.dispatch(commands.deleteChannels(selection));
  }, [store, commands, selection]);

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
          onClick={() => store.dispatch(commands.addTrack())}
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
              store={store}
              commands={commands}
              engine={engine}
              selected={selectedChannelId === id}
              onSelect={onSelectChannel}
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
