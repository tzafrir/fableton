// The lane-header column: one row per channel, in `channelOrder` (the frozen
// row convention). SS15: "DOM is reserved for bounded-count UI" — a project
// has tens of channels, not thousands, so headers are plain elements while
// clips stay on canvas.
//
// Headers own the per-channel document verbs: select, mute, solo, RENAME
// (double-click the name — `renameChannel` was reachable from no UI at all
// until then, so every track stayed "Track 1"), and reorder within
// `channelOrder`. Each is one command, exactly like a drag (SS13).

import type { DocumentStore, ProjectCommands } from "../../types/commands";
import type { ChannelId } from "../../types/ids";
import type { Viewport } from "../../types/viewport";
import type { ArrangementTheme } from "./constants";
import { HEADER_WIDTH_PX } from "./constants";
import type { ArrangementScene } from "./scene";

export interface HeadersOptions {
  container: HTMLElement;
  viewport: Viewport;
  scene: ArrangementScene;
  store: DocumentStore;
  commands: ProjectCommands;
  theme: ArrangementTheme;
  onSelectChannel?: ((channelId: ChannelId) => void) | undefined;
}

export interface LaneHeadersView {
  readonly element: HTMLElement;
  /** Rebuilds the rows from the scene (lane set / names / colours changed). */
  rebuild(): void;
  /** Re-positions the existing rows (scroll / zoom). */
  reposition(): void;
  setSelectedChannel(channelId: ChannelId | null): void;
  readonly selectedChannel: ChannelId | null;
  dispose(): void;
}

interface HeaderRow {
  readonly channelId: ChannelId;
  readonly row: number;
  readonly element: HTMLElement;
}

function button(label: string, title: string, theme: ArrangementTheme): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.title = title;
  el.style.font = "10px system-ui, sans-serif";
  el.style.width = "18px";
  el.style.height = "16px";
  el.style.padding = "0";
  el.style.cursor = "pointer";
  el.style.color = theme.headerText;
  el.style.background = "transparent";
  el.style.border = `1px solid ${theme.headerBorder}`;
  el.style.borderRadius = "3px";
  return el;
}

export function createLaneHeaders(options: HeadersOptions): LaneHeadersView {
  const { viewport, scene, theme } = options;
  let rows: HeaderRow[] = [];
  let selected: ChannelId | null = null;
  let disposed = false;

  const element = document.createElement("div");
  element.className = "fbl-arr-headers";
  element.style.position = "relative";
  element.style.overflow = "hidden";
  element.style.width = `${String(HEADER_WIDTH_PX)}px`;
  element.style.height = "100%";
  element.style.background = theme.headerBackground;
  options.container.appendChild(element);

  const paint = (): void => {
    for (const row of rows) {
      const isSelected = row.channelId === selected;
      row.element.style.background = isSelected ? theme.laneEven : "transparent";
      row.element.style.color = theme.headerText;
    }
  };

  const reposition = (): void => {
    for (const row of rows) {
      row.element.style.transform = `translateY(${String(Math.round(viewport.yOf(row.row)))}px)`;
      row.element.style.height = `${String(Math.max(0, viewport.pxPerRow - 1))}px`;
    }
  };

  const rebuild = (): void => {
    element.textContent = "";
    rows = [];
    for (const lane of scene.rows) {
      const box = document.createElement("div");
      box.className = "fbl-arr-header";
      box.dataset["channelId"] = lane.channelId;
      box.style.position = "absolute";
      box.style.left = "0";
      box.style.top = "0";
      box.style.width = "100%";
      box.style.boxSizing = "border-box";
      box.style.borderBottom = `1px solid ${theme.headerBorder}`;
      box.style.padding = "4px 6px";
      box.style.font = "12px system-ui, sans-serif";
      box.style.cursor = "pointer";
      box.style.overflow = "hidden";

      const title = document.createElement("div");
      title.className = "fbl-arr-header-name";
      title.textContent = lane.channel.name;
      title.title = "Double-click to rename";
      title.style.whiteSpace = "nowrap";
      title.style.textOverflow = "ellipsis";
      title.style.overflow = "hidden";
      if (lane.channel.color !== null) title.style.borderLeft = `3px solid ${lane.channel.color}`;
      if (lane.channel.color !== null) title.style.paddingLeft = "5px";

      // Double-click the name to rename in place. The input replaces the
      // label rather than overlaying it, so the row's height never changes
      // (the frozen row convention: a row IS `viewport.pxPerRow` tall).
      title.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (title.querySelector("input") !== null) return;
        const input = document.createElement("input");
        input.className = "fbl-arr-header-rename";
        input.value = lane.channel.name;
        input.style.width = "100%";
        input.style.boxSizing = "border-box";
        input.style.font = "inherit";
        input.style.color = theme.headerText;
        input.style.background = theme.headerBackground;
        input.style.border = `1px solid ${theme.marqueeOutline}`;
        input.style.borderRadius = "2px";
        input.style.padding = "0 2px";
        // Removing a focused input fires `blur`, so Enter/Escape would both
        // fall through into the blur handler — and Escape would commit the
        // very text it just discarded. One latch settles the edit exactly once.
        let settled = false;
        const finish = (accept: boolean): void => {
          if (settled) return;
          settled = true;
          const next = input.value.trim();
          input.remove();
          const keep = accept && next.length > 0 && next !== lane.channel.name;
          title.textContent = keep ? next : lane.channel.name;
          if (keep) {
            options.store.dispatch(options.commands.renameChannel(lane.channelId, next));
          }
        };
        input.addEventListener("keydown", (e) => {
          e.stopPropagation(); // never let the arrangement key map see this
          if (e.key === "Enter") finish(true);
          else if (e.key === "Escape") finish(false);
        });
        input.addEventListener("blur", () => finish(true));
        input.addEventListener("pointerdown", (e) => e.stopPropagation());
        title.textContent = "";
        title.appendChild(input);
        input.focus();
        input.select();
      });
      box.appendChild(title);

      if (lane.isTrack) {
        const strip = document.createElement("div");
        strip.style.display = "flex";
        strip.style.gap = "3px";
        strip.style.marginTop = "3px";

        const mute = button("M", "Mute", theme);
        mute.setAttribute("aria-pressed", String(lane.channel.mute));
        if (lane.channel.mute) mute.style.background = theme.clipLoopBrace;
        mute.addEventListener("click", (event) => {
          event.stopPropagation();
          options.store.dispatch(options.commands.setChannelMuted(lane.channelId, !lane.channel.mute));
        });

        const solo = button("S", "Solo", theme);
        solo.setAttribute("aria-pressed", String(lane.channel.solo));
        if (lane.channel.solo) solo.style.background = theme.marqueeOutline;
        solo.addEventListener("click", (event) => {
          event.stopPropagation();
          options.store.dispatch(options.commands.setChannelSolo(lane.channelId, !lane.channel.solo));
        });

        // Reorder within `channelOrder` — which IS the arrangement's row
        // order (document invariant 2), so this moves the lane on screen.
        const up = button("\u25b2", "Move track up", theme);
        up.disabled = lane.row <= 0;
        up.addEventListener("click", (event) => {
          event.stopPropagation();
          options.store.dispatch(options.commands.moveChannel(lane.channelId, lane.row - 1));
        });

        const down = button("\u25bc", "Move track down", theme);
        down.disabled = lane.row >= scene.rows.length - 1;
        down.addEventListener("click", (event) => {
          event.stopPropagation();
          options.store.dispatch(options.commands.moveChannel(lane.channelId, lane.row + 1));
        });

        strip.appendChild(mute);
        strip.appendChild(solo);
        strip.appendChild(up);
        strip.appendChild(down);
        box.appendChild(strip);
      }

      box.addEventListener("pointerdown", () => {
        selected = lane.channelId;
        paint();
        options.onSelectChannel?.(lane.channelId);
      });

      element.appendChild(box);
      rows.push({ channelId: lane.channelId, row: lane.row, element: box });
    }
    reposition();
    paint();
  };

  rebuild();
  const unsubscribe = viewport.onChange(reposition);

  return {
    element,
    rebuild,
    reposition,
    setSelectedChannel(channelId: ChannelId | null): void {
      selected = channelId;
      paint();
    },
    get selectedChannel() {
      return selected;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      element.remove();
    },
  };
}
