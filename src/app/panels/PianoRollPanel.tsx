// SS15's imperative bridge for the piano roll (SS10). Same discipline as
// `ArrangementPanel`: the view is built once per `(store, commands)` and
// lives entirely outside React after that. `clipId`/`tool` DO need to reach
// an already-mounted view reactively (opening a different clip is a React
// state change, not a remount), so those two go through the view's own
// `setClip`/`setTool` in a second effect instead of being create-time-only.

import { useEffect, useRef, type MutableRefObject } from "react";
import { createPianoRoll } from "../../editor/pianoroll";
import type {
  AuditionSink,
  ClipId,
  DocumentStore,
  PianoRollView,
  ProjectCommands,
  Ticks,
  ToolMode,
} from "../../types";

export interface PianoRollPanelProps {
  store: DocumentStore;
  commands: ProjectCommands;
  clipId: ClipId | null;
  tool?: ToolMode | undefined;
  onSeek?: ((tick: Ticks) => void) | undefined;
  /** A STABLE sink (the app shell owns one proxy object for the lifetime of
   *  the engine and redirects it as the open clip's track changes) — passed
   *  once at creation, per `PianoRollOptions`. */
  audition?: AuditionSink | undefined;
  viewRef?: MutableRefObject<PianoRollView | null> | undefined;
}

export function PianoRollPanel({
  store,
  commands,
  clipId,
  tool,
  onSeek,
  audition,
  viewRef,
}: PianoRollPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const localViewRef = useRef<PianoRollView | null>(null);

  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  // Read once, at creation — see the prop doc comment above.
  const initialClipId = useRef(clipId);
  const initialTool = useRef(tool);
  const initialAudition = useRef(audition);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const view = createPianoRoll({
      container,
      store,
      commands,
      clipId: initialClipId.current,
      tool: initialTool.current,
      audition: initialAudition.current,
      onSeek: (tick) => onSeekRef.current?.(tick),
    });
    localViewRef.current = view;
    if (viewRef !== undefined) viewRef.current = view;
    return () => {
      localViewRef.current = null;
      if (viewRef !== undefined) viewRef.current = null;
      view.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, commands]);

  useEffect(() => {
    localViewRef.current?.setClip(clipId);
  }, [clipId]);

  useEffect(() => {
    if (tool !== undefined) localViewRef.current?.setTool(tool);
  }, [tool]);

  return (
    <div
      ref={containerRef}
      data-testid="piano-roll-panel"
      style={{ width: "100%", height: "100%", minHeight: 0, minWidth: 0 }}
    />
  );
}
