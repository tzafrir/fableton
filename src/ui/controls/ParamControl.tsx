// SS5 — the shared DOM shell every control renders inside.
//
// One component owns the ENTIRE gesture surface (pointer capture, cursor
// hiding, the floating readout, double-click text entry, wheel, keyboard,
// Alt-click reset, Esc revert, the right-click menu), delegating the value
// math to ./gesture.ts. Knob/Fader/etc. only draw — which is exactly how
// "the little things become a conformance table instead of folklore".
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
import type { ParamHandle } from "../../types";
import { createControlGesture } from "./gesture";

export interface ParamControlProps {
  handle: ParamHandle;
  /** Draws the control face given the live value. */
  children: (value: number, dragging: boolean) => ReactNode;
  /** Post-processes the live value during a DRAG only (fader 0 dB detent).
   *  `fine` (Shift) bypasses it, per the SS5 fader row. */
  snapDragValue?: ((value: number) => number) | undefined;
  /** Extra class for styling hooks. */
  className?: string | undefined;
  testId?: string | undefined;
  /** SS5 context-menu "Show/create automation lane" — wired by M3; the menu
   *  entry renders whenever this is present. */
  onShowAutomation?: (() => void) | undefined;
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
  onShowAutomation,
  title,
}: ParamControlProps) {
  const value = useParamValue(handle);
  const gesture = useMemo(() => createControlGesture(handle), [handle]);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
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

  const onDoubleClick = useCallback((): void => {
    // SS5: inline numeric entry parsed by `fromText`.
    setEditText(handle.desc.toText(handle.live()));
    setEditing(true);
  }, [handle]);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>): void => {
      // Hover-only by construction: the listener is on the control root.
      e.preventDefault();
      e.stopPropagation();
      gesture.wheel(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    },
    [gesture],
  );

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
          onDoubleClick();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    [editing, gesture, onDoubleClick],
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
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      style={{
        position: "relative",
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        touchAction: "none",
        userSelect: "none",
        // SS5: cursor hidden during drag, restored on release.
        cursor: dragging ? "none" : "ns-resize",
        outline: "none",
      }}
    >
      {children(value, dragging)}

      {dragging && (
        // SS5: floating readout follows the control showing toText(live()).
        <div
          className="fbl-control-readout"
          data-testid={testId !== undefined ? `${testId}-readout` : undefined}
          style={{
            position: "absolute",
            bottom: "100%",
            left: "50%",
            transform: "translateX(-50%)",
            padding: "2px 6px",
            background: "#111",
            color: "#eee",
            border: "1px solid #444",
            borderRadius: 3,
            fontSize: 11,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 40,
          }}
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
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: 64,
            fontSize: 11,
            textAlign: "center",
            zIndex: 41,
          }}
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
            style={{
              position: "fixed",
              left: menu.x,
              top: menu.y,
              zIndex: 50,
              background: "#181818",
              border: "1px solid #444",
              borderRadius: 4,
              padding: 4,
              display: "flex",
              flexDirection: "column",
              minWidth: 160,
              fontSize: 12,
              color: "#ddd",
            }}
          >
            <MenuItem
              label="Type value…"
              onPick={() => {
                setMenu(null);
                onDoubleClick();
              }}
            />
            <MenuItem
              label="Reset"
              onPick={() => {
                setMenu(null);
                gesture.reset();
              }}
            />
            {onShowAutomation !== undefined && (
              <MenuItem
                label="Show automation lane"
                onPick={() => {
                  setMenu(null);
                  onShowAutomation();
                }}
              />
            )}
            <MenuItem label="Copy param path" onPick={copyParamPath} />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({ label, onPick }: { label: string; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      style={{
        background: "none",
        border: "none",
        color: "inherit",
        textAlign: "left",
        padding: "4px 8px",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      {label}
    </button>
  );
}
