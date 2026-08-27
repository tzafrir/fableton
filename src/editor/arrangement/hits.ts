// SS10's hover model, arrangement flavour: "Hover resolves to a zone before
// any button is pressed, and the cursor reflects it."
//
// Two hit-testers, in priority order:
//   `clip` (priority 10) — the clip under the pointer and WHICH zone of it
//   `lane` (priority  0) — the catch-all background, so empty lanes are still
//                          a target (create / marquee / clear selection)
//
// Both are pure functions of (scene, viewport, point): no DOM, no
// `elementFromPoint` (SS10's "why DOM failed"), just math against the model.

import type { ChannelId, ClipId } from "../../types/ids";
import type { EditorPoint, HitTarget, HitTester } from "../../types/gesture";
import type { Viewport } from "../../types/viewport";
import { LOOP_HANDLE_PX } from "./constants";
import type { ClipZone } from "./geometry";
import { ZONE_CURSORS, zoneAt } from "./geometry";
import type { ArrangementScene } from "./scene";

export interface ArrangementClipHit extends HitTarget {
  readonly kind: "clip";
  readonly zone: ClipZone;
  readonly clipId: ClipId;
  readonly trackId: ChannelId;
  readonly row: number;
  readonly cursor: string;
}

export interface ArrangementLaneHit extends HitTarget {
  readonly kind: "lane";
  readonly row: number;
  /** `null` for a row with no channel (below the last lane never hits). */
  readonly channelId: ChannelId | null;
  /** Only `'track'` lanes accept clips (SS6: groups/returns/master do not). */
  readonly isTrack: boolean;
  readonly cursor: string;
}

export type ArrangementHit = ArrangementClipHit | ArrangementLaneHit;

export function isClipHit(hit: ArrangementHit | null): hit is ArrangementClipHit {
  return hit !== null && hit.kind === "clip";
}

export function isLaneHit(hit: ArrangementHit | null): hit is ArrangementLaneHit {
  return hit !== null && hit.kind === "lane";
}

export function createClipHitTester(
  scene: ArrangementScene,
  viewport: Viewport,
): HitTester<ArrangementHit> {
  return {
    id: "arrangement.clip",
    priority: 10,
    hitTest(point: EditorPoint): ArrangementHit | null {
      const row = Math.floor(point.row);
      if (row < 0 || row >= scene.rowCount()) return null;
      // The window is widened by the grab tolerance so a clip whose brace
      // handle sits exactly on the window boundary is still a candidate; the
      // zones themselves stay INSIDE the clip (SS10), which is what keeps an
      // empty lane clickable right up to a clip's edge.
      const from = viewport.tAt(point.xPx - LOOP_HANDLE_PX);
      const to = viewport.tAt(point.xPx + LOOP_HANDLE_PX) + 1;
      const candidates = scene.clipsInRange(row, from, to);
      // Reverse: later clips paint on top, so they win the hit.
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const clip = candidates[i];
        if (clip === undefined) continue;
        const zone = zoneAt(viewport, clip, row, point.xPx, point.yPx);
        if (zone === null) continue;
        return {
          kind: "clip",
          zone,
          clipId: clip.id,
          trackId: clip.trackId,
          row,
          cursor: ZONE_CURSORS[zone],
        };
      }
      return null;
    },
  };
}

export function createLaneHitTester(scene: ArrangementScene): HitTester<ArrangementHit> {
  return {
    id: "arrangement.lane",
    priority: 0,
    hitTest(point: EditorPoint): ArrangementHit | null {
      const row = Math.floor(point.row);
      if (row < 0 || row >= scene.rowCount()) return null;
      const channel = scene.channelAt(row);
      const isTrack = scene.isTrackRow(row);
      return {
        kind: "lane",
        row,
        channelId: channel?.id ?? null,
        isTrack,
        cursor: isTrack ? "crosshair" : "default",
      };
    },
  };
}

export function createHitTesters(
  scene: ArrangementScene,
  viewport: Viewport,
): readonly HitTester<ArrangementHit>[] {
  return [createClipHitTester(scene, viewport), createLaneHitTester(scene)];
}
