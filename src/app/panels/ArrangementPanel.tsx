// SS15 "App chrome (React, chrome only) ... Editors mount as opaque canvas
// components with an imperative bridge." This component IS that bridge for
// the arrangement lanes: React owns exactly one thing — the container div —
// and every frame of interaction after that (viewport, gestures, canvas
// layers, the DOM playhead) belongs to `createArrangement` (SS9), reached
// only through the `ArrangementView` handle `editor.ts` freezes.
//
// The view is created ONCE per `(store, commands)` pair and never rebuilt on
// a React re-render: callbacks are threaded through refs so a new closure
// identity on `onSeek`/`onOpenClip`/`onSelectChannel` does not tear down and
// remount the canvas editor underneath the user's hands.

import { useEffect, useRef, type MutableRefObject } from "react";
import { createArrangement } from "../../editor/arrangement";
import type {
  ArrangementView,
  ChannelId,
  ClipId,
  DocumentStore,
  GridSettings,
  ProjectCommands,
  Ticks,
} from "../../types";

export interface ArrangementPanelProps {
  store: DocumentStore;
  commands: ProjectCommands;
  /** SS10's grid override menu / triplet toggle, owned by the toolbar and
   *  pushed into the live view (never a remount). */
  grid?: Partial<GridSettings> | undefined;
  onSeek?: ((tick: Ticks) => void) | undefined;
  onOpenClip?: ((clipId: ClipId) => void) | undefined;
  onSelectChannel?: ((channelId: ChannelId) => void) | undefined;
  /** The shell's current channel selection, mirrored into the lane header
   *  highlight so the header and the mixer/device chain never disagree about
   *  which track is selected (the header drives it back out through
   *  `onSelectChannel`). */
  selectedChannelId?: ChannelId | null | undefined;
  /** The app shell reads `.current` at rAF while playing to push the
   *  playhead (SS9: a DOM element, never a canvas invalidation) and to call
   *  toolbar verbs (`splitSelection`, `toggleLoop` live on the wider
   *  `KitArrangementView`, reachable through this same ref if a caller casts
   *  it — `ArrangementView` itself only promises what `editor.ts` freezes). */
  viewRef?: MutableRefObject<ArrangementView | null> | undefined;
}

export function ArrangementPanel({
  store,
  commands,
  grid,
  onSeek,
  onOpenClip,
  onSelectChannel,
  selectedChannelId,
  viewRef,
}: ArrangementPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewLocalRef = useRef<ArrangementView | null>(null);
  const initialGrid = useRef(grid);

  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const onOpenClipRef = useRef(onOpenClip);
  onOpenClipRef.current = onOpenClip;
  const onSelectChannelRef = useRef(onSelectChannel);
  onSelectChannelRef.current = onSelectChannel;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const view = createArrangement({
      container,
      store,
      commands,
      grid: initialGrid.current,
      onSeek: (tick) => onSeekRef.current?.(tick),
      onOpenClip: (clipId) => onOpenClipRef.current?.(clipId),
      onSelectChannel: (channelId) => onSelectChannelRef.current?.(channelId),
    });
    viewLocalRef.current = view;
    if (viewRef !== undefined) viewRef.current = view;
    return () => {
      viewLocalRef.current = null;
      if (viewRef !== undefined) viewRef.current = null;
      view.dispose();
    };
    // `store`/`commands` are the only reactive deps: they are the whole
    // identity of "which document this editor is for" (SS15's opaque
    // component boundary). Callbacks are read from the refs above instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, commands]);

  useEffect(() => {
    if (grid !== undefined) viewLocalRef.current?.setGrid(grid);
  }, [grid]);

  useEffect(() => {
    if (selectedChannelId !== undefined) {
      viewLocalRef.current?.setSelectedChannel(selectedChannelId);
    }
  }, [selectedChannelId]);

  return (
    <div
      ref={containerRef}
      data-testid="arrangement-panel"
      style={{ width: "100%", height: "100%", minHeight: 0, minWidth: 0 }}
    />
  );
}
