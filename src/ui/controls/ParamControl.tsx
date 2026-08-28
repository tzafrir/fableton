// SS5 — the shared DOM shell every control renders inside.
//
// One component owns the ENTIRE gesture surface (pointer capture, cursor
// hiding, the floating readout, the value line, wheel, keyboard, reset, Esc
// revert, the right-click menu), delegating the value math to ./gesture.ts.
// Knob/Fader/etc. only draw — which is exactly how "the little things become
// a conformance table instead of folklore".
//
// The three mouse verbs are one each, and none of them overlaps another:
//
//   double-click on the face   ->  reset to default
//   click the value line       ->  type a value
//   right-click                ->  menu, automation lane first
//
// Text entry used to live on the double-click, which made "put this back"
// the awkward one (Alt+click, undiscoverable) and spent the most obvious
// gesture on the rarest verb. The value line pays for itself twice over: it
// is the type-a-number target AND it is where a knob finally shows its value
// without being dragged — hover any control and the label swaps to the
// number, which is how every DAW mixer reads.
//
// Controls are DOM/SVG, not canvas (SS5: "a few dozen live controls don't
// need canvas"). Accessibility per the spec: tabbable, `role="slider"`,
// `aria-valuetext` from `toText`.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { ParamHandle, ParamState } from "../../types";
import { createControlGesture } from "./gesture";
import { SIGNAL } from "../theme";

export interface ParamControlProps {
  handle: ParamHandle;
  /** Draws the control face given the live value, whether a drag is in
   *  flight, and the SS4 automation state (SS5 control inventory: an
   *  `overridden` param must READ as overridden — "arc pulses dim"). */
  children: (value: number, dragging: boolean, state: ParamState) => ReactNode;
  /** Post-processes the live value during a DRAG only (fader 0 dB detent).
   *  `fine` (Shift) bypasses it, per the SS5 fader row. */
  snapDragValue?: ((value: number) => number) | undefined;
  /** Extra class for styling hooks. */
  className?: string | undefined;
  testId?: string | undefined;
  /** Text for the line under the control — omit it and no line is drawn.
   *  Whatever it says, the line is the click-to-type target, and it swaps to
   *  the formatted value while the pointer is over the control. */
  label?: string | undefined;
  /** Show the VALUE on that line at all times, not only on hover. What a
   *  mixer fader wants: the number IS the label there. */
  labelShowsValue?: boolean | undefined;
  labelMaxWidth?: number | undefined;
  /** SS5 context-menu "Show/create automation lane" — wired by M3; the menu
   *  entry renders whenever this is present, and it is the FIRST entry
   *  because reaching automation is what a right-click on a param is for. */
  onShowAutomation?: (() => void) | undefined;
  /** Whether the lane already exists, so the menu can say `Show` rather than
   *  `Add`. Unknown (undefined) reads as "not yet". */
  hasAutomation?: boolean | undefined;
  title?: string | undefined;
}

/** Reads the handle's live value reactively (rAF-coalesced via onChange). */
export function useParamValue(handle: ParamHandle): number {
  const [value, setValue] = useState(() => handle.live());
  useEffect(() => {
    setValue(handle.live());
    return handle.onChange((v) => setValue(v));
  }, [handle]);
  return value;
}

/**
 * Live value AND SS4 state, in one subscription.
 *
 * Why not two `useState`s over `onChange(v => ...)`: a state flip
 * (`automated` -> `overridden`) marks the handle dirty but does NOT move the
 * value, so a `setValue(sameNumber)` bails out of re-rendering and the control
 * would keep drawing the old state forever. Reading `handle.state` inside the
 * same callback — and storing both in one object — is what makes the state
 * change actually repaint.
 */
export function useParamDisplay(handle: ParamHandle): { value: number; state: ParamState } {
  const [display, setDisplay] = useState(() => ({ value: handle.live(), state: handle.state }));
  useEffect(() => {
    const read = (): void => {
      setDisplay((previous) =>
        previous.value === handle.live() && previous.state === handle.state
          ? previous
          : { value: handle.live(), state: handle.state },
      );
    };
    read(); // the handle may have moved between render and effect
    return handle.onChange(read);
  }, [handle]);
  return display;
}

/** Accent for the live value (arc, fader fill) — one palette for the kit. */
export const ARC_ACCENT = SIGNAL.aqua;
/** SS5 "overridden = arc pulses dim": desaturated, plus the pulse the faces
 *  animate. Naming it here keeps knob and fader saying the same thing. */
export const ARC_OVERRIDDEN = "#6b7787";

interface MenuState {
  x: number;
  y: number;
}

export function ParamControl({
  handle,
  children,
  snapDragValue,
  className,
  testId,
  label,
  labelShowsValue,
  labelMaxWidth,
  onShowAutomation,
  hasAutomation,
  title,
}: ParamControlProps) {
  const { value, state } = useParamDisplay(handle);
  const gesture = useMemo(() => createControlGesture(handle), [handle]);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [hovered, setHovered] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Esc during a drag is a WINDOW-level concern: the pointer is captured and
  // focus may be anywhere.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        gesture.dragCancel();
        setDragging(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging, gesture]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (editing) return;
      if (e.button === 2) return; // context menu path
      if (e.button !== 0) return;
      e.preventDefault();
      rootRef.current?.focus();
      if (e.altKey) {
        // SS5: Alt+click resets.
        gesture.reset();
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      gesture.dragStart(e.clientY, e.shiftKey);
      setDragging(true);
    },
    [editing, gesture],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!gesture.dragging) return;
      gesture.dragMove(e.clientY, e.shiftKey);
      if (snapDragValue !== undefined && !e.shiftKey) {
        const snapped = snapDragValue(handle.live());
        if (snapped !== handle.live()) handle.setLive(snapped, "user");
      }
    },
    [gesture, handle, snapDragValue],
  );

  const onPointerUp = useCallback((): void => {
    if (!gesture.dragging) return;
    gesture.dragEnd();
    setDragging(false);
  }, [gesture]);

  const onPointerCancel = useCallback((): void => {
    if (!gesture.dragging) return;
    gesture.dragCancel();
    setDragging(false);
  }, [gesture]);

  /** Open the inline numeric entry, parsed back by `fromText`. Reached from
   *  the value line, from `Enter`, and from the menu — never from a gesture
   *  on the face, which now belongs to reset. */
  const beginEdit = useCallback((): void => {
    setEditText(handle.desc.toText(handle.live()));
    setEditing(true);
  }, [handle]);

  // Double-click on the face resets to the default. It is the gesture people
  // TRY first (it is what a fader does in every DAW, and what the app's own
  // splitter does), and until now it opened a text field instead — so the
  // one thing a mis-dragged knob needs was the one thing hidden behind a
  // modifier. Alt+click still resets too; nothing was taken away.
  const onDoubleClick = useCallback((): void => {
    gesture.reset();
  }, [gesture]);

  // SS5 says "wheel events consumed only while hovering the control proper".
  // Hover alone turned out to be too generous a claim on the wheel: a device
  // chain is a SCROLLING column of knobs, so a trackpad flick aimed at the
  // panel lands on whatever control the pointer happens to be crossing, and
  // the scroll stops dead while that knob silently walks. Hover says "the
  // pointer is here"; it does not say "I am adjusting this".
  //
  // So the control takes the wheel only once it is FOCUSED — i.e. after a
  // click or a Tab, the same gate the arrow-key steps below already sit
  // behind. Un-focused, the handler returns without `preventDefault()` and
  // the wheel travels on to the panel, which is the behaviour the user
  // actually wants nine times out of ten. `activeElement === el` and not
  // `el.contains(...)`: while the inline text entry has focus the wheel is
  // the field's, not the param's.
  //
  // Deliberately NOT React's `onWheel`: React 19 registers `wheel` on the root
  // container as a PASSIVE listener, so `preventDefault()` from a synthetic
  // handler does nothing (and Chrome logs an error per notch) — the strip row
  // and the page keep scrolling while the knob steps, sliding the control out
  // from under the pointer mid-adjustment. A native listener on the control
  // root with `{ passive: false }` is the only way to consume it (same shape
  // as the editor kit's `gestureEngine` DOM binding).
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      if (el.ownerDocument.activeElement !== el) return;
      e.preventDefault();
      e.stopPropagation();
      // Shift+wheel and trackpad side-swipes arrive on deltaX on some
      // platforms (`points.ts` makes the same fallback for the editors), and a
      // zero delta carries no direction at all — reading `deltaY < 0 ? 1 : -1`
      // blind turned every one of those into a DOWNWARD notch that dirtied the
      // document. `deltaMode` needs no normalization here because only the
      // sign is used and both axes carry the same mode.
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      gesture.wheel(delta < 0 ? 1 : -1, e.shiftKey);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [gesture]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (editing) return;
      switch (e.key) {
        case "ArrowUp":
          gesture.keyStep(1, { fine: e.shiftKey });
          break;
        case "ArrowDown":
          gesture.keyStep(-1, { fine: e.shiftKey });
          break;
        case "PageUp":
          gesture.keyStep(1, { page: true });
          break;
        case "PageDown":
          gesture.keyStep(-1, { page: true });
          break;
        case "Delete":
        case "Backspace":
          gesture.reset();
          break;
        case "Enter":
          beginEdit();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    [beginEdit, editing, gesture],
  );

  const onContextMenu = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const commitEdit = useCallback((): void => {
    gesture.setFromText(editText);
    setEditing(false);
  }, [editText, gesture]);

  const copyParamPath = useCallback((): void => {
    void navigator.clipboard?.writeText(handle.desc.id).catch(() => undefined);
    setMenu(null);
  }, [handle]);

  return (
    <div
      ref={rootRef}
      className={`fbl-control ${className ?? ""}`.trim()}
      data-testid={testId}
      data-param-state={state}
      data-dragging={dragging}
      role="slider"
      tabIndex={0}
      title={title ?? handle.desc.label}
      aria-label={handle.desc.label}
      aria-valuemin={handle.desc.min}
      aria-valuemax={handle.desc.max}
      aria-valuenow={value}
      aria-valuetext={handle.desc.toText(value)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
    >
      {children(value, dragging, state)}

      {label !== undefined && (
        // The value line. Not a <button>: this sits inside `role="slider"`,
        // where a second focusable child would be announced as its own
        // control and would steal the Tab stop the slider needs. The verbs it
        // carries are all reachable from the keyboard on the slider itself
        // (`Enter` types, `Delete` resets), so it is chrome for the mouse.
        <span
          className="fbl-control-label"
          data-testid={testId !== undefined ? `${testId}-label` : undefined}
          data-showing={labelShowsValue === true || hovered || dragging ? "value" : "label"}
          aria-hidden="true"
          title="Click to type a value"
          style={labelMaxWidth === undefined ? undefined : { maxWidth: labelMaxWidth }}
          // The face below is a drag surface; a press on the line must not
          // start one, or every attempt to click it would nudge the value.
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            rootRef.current?.focus();
            beginEdit();
          }}
        >
          {labelShowsValue === true || hovered || dragging
            ? handle.desc.toText(value)
            : label}
        </span>
      )}

      {dragging && (
        // SS5: floating readout follows the control showing toText(live()).
        <div
          className="fbl-control-readout"
          data-testid={testId !== undefined ? `${testId}-readout` : undefined}
        >
          {handle.desc.toText(value)}
        </div>
      )}

      {editing && (
        <input
          ref={inputRef}
          className="fbl-control-entry"
          data-testid={testId !== undefined ? `${testId}-entry` : undefined}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitEdit();
            else if (e.key === "Escape") setEditing(false);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}

      {menu !== null && (
        <>
          {/* click-away layer */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 49 }}
            onPointerDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fbl-control-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
          >
            {onShowAutomation !== undefined && (
              <MenuItem
                label={hasAutomation === true ? "Show automation lane" : "Add automation lane"}
                testId={testId !== undefined ? `${testId}-menu-automation` : undefined}
                onPick={() => {
                  setMenu(null);
                  onShowAutomation();
                }}
              />
            )}
            <MenuItem
              label="Type value…"
              onPick={() => {
                setMenu(null);
                beginEdit();
              }}
            />
            <MenuItem
              label="Reset"
              onPick={() => {
                setMenu(null);
                gesture.reset();
              }}
            />
            <MenuItem label="Copy param path" onPick={copyParamPath} />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  label,
  onPick,
  testId,
}: {
  label: string;
  onPick: () => void;
  testId?: string | undefined;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="fbl-menu-item"
      data-testid={testId}
      onClick={onPick}
    >
      {label}
    </button>
  );
}
