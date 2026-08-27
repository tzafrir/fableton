// The lane-header column: one row per channel, in `channelOrder` (the frozen
// row convention). SS15: "DOM is reserved for bounded-count UI" — a project
// has tens of channels, not thousands, so headers are plain elements while
// clips stay on canvas.
//
// Headers own three document verbs (`renameChannel` is the shell's job in
// M1): select the track, mute it, solo it. Each is one command, exactly like
// a drag (SS13).

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
      title.style.whiteSpace = "nowrap";
      title.style.textOverflow = "ellipsis";
      title.style.overflow = "hidden";
      if (lane.channel.color !== null) title.style.borderLeft = `3px solid ${lane.channel.color}`;
      if (lane.channel.color !== null) title.style.paddingLeft = "5px";
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

        strip.appendChild(mute);
        strip.appendChild(solo);
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
