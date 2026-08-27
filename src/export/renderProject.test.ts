// SS12 "Export" — the pure half of the offline render: WHICH ticks get
// rendered and how long the resulting file is. The audio half needs a real
// OfflineAudioContext and lives in e2e/export/; this is everything that
// decides the WAV's duration, which is the first thing a user would notice
// going wrong.

import { describe, expect, it } from "vitest";
import { PPQ, type Project, type ProjectSnapshot } from "../types";
import { createTempoMap } from "../time";
import { contentEndTick, EXPORT_TAIL_SECONDS, renderSpan } from "./renderProject";
import { cloneProject, makeFixtureProject, TRACK_ID } from "../persist/testing/fixture";

const BAR = PPQ * 4;

const SECOND_TRACK_ID = "chan-track-2";

/** The fixture project, plus a second track, with `clips` replaced by
 *  `[start, length, trackId?]` tuples. */
function docWithClips(
  spans: readonly (readonly [number, number, string?])[],
): Project {
  const project = cloneProject(makeFixtureProject());
  project.channels[SECOND_TRACK_ID] = {
    ...project.channels[TRACK_ID]!,
    id: SECOND_TRACK_ID,
    name: "Track 2",
    source: null,
    sends: [],
  };
  project.channelOrder = [TRACK_ID, SECOND_TRACK_ID, ...project.channelOrder.slice(1)];
  project.clips = {};
  spans.forEach(([start, length, trackId], i) => {
    project.clips[`c${i}`] = {
      id: `c${i}`,
      trackId: trackId ?? TRACK_ID,
      start,
      length,
      notes: [],
      name: `c${i}`,
      color: null,
    };
  });
  return project;
}

describe("contentEndTick", () => {
  it("is 0 for a document with no clips", () => {
    expect(contentEndTick(docWithClips([]))).toBe(0);
  });

  it("counts a clip's start, not just its length", () => {
    // The truncating regression this guards: `max(clip.length)` would say
    // one bar here and cut the exported file in three.
    expect(contentEndTick(docWithClips([[BAR * 2, BAR]]))).toBe(BAR * 3);
  });

  it("takes the furthest end across every track, whatever order they are in", () => {
    const doc = docWithClips([
      [BAR * 4, BAR, SECOND_TRACK_ID],
      [0, BAR * 2],
      [BAR, BAR, SECOND_TRACK_ID],
    ]);
    expect(contentEndTick(doc)).toBe(BAR * 5);
  });
});

describe("renderSpan", () => {
  const seconds = (doc: ProjectSnapshot, from: number, to: number): number =>
    createTempoMap(doc.tempo).secondsBetween(from, to) + EXPORT_TAIL_SECONDS;

  it("covers [0, content end] plus the tail by default", () => {
    const doc = docWithClips([[BAR, BAR]]);
    const span = renderSpan(doc);
    expect(span).toMatchObject({ fromTick: 0, toTick: BAR * 2 });
    expect(span.durationSeconds).toBeCloseTo(seconds(doc, 0, BAR * 2), 9);
  });

  it("floors an empty document at one beat past `fromTick` (a valid file, not a zero-length one)", () => {
    const doc = docWithClips([]);
    expect(renderSpan(doc).toTick).toBe(PPQ);
    expect(renderSpan(doc, { fromTick: BAR })).toMatchObject({ fromTick: BAR, toTick: BAR + PPQ });
  });

  it("honours an explicit span and follows the tempo map", () => {
    const doc = docWithClips([[0, BAR * 8]]);
    doc.tempo = [{ startTick: 0, bpm: 60 }];
    const span = renderSpan(doc, { fromTick: BAR, toTick: BAR * 2 });
    expect(span).toMatchObject({ fromTick: BAR, toTick: BAR * 2 });
    // One bar at 60 bpm is exactly 4 seconds, plus the release/reverb tail.
    expect(span.durationSeconds).toBeCloseTo(4 + EXPORT_TAIL_SECONDS, 9);
  });
});
