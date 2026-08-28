// Audio clips on the timeline — the `WindowFiller` that plays them.
//
// The transport already fills a look-ahead window for notes and for SS11's
// automation; this registers alongside them and does the same job for
// `Project.audioClips`: for every clip whose start falls inside the window,
// create a buffer source on that track's INPUT node and start it at the
// right audio-clock second, so the file goes through the track's effects and
// fader exactly like an instrument would.
//
// Everything about time comes from the tempo map the transport hands in, so
// this adds no third tick<->seconds conversion (SS8 keeps that in two
// places): a clip's start is converted the same way a note's is.
//
// TWO CASES, and the second is the one that is easy to miss:
//
//   1. The window advances normally and a clip's start is inside it. Schedule
//      it from its own `offsetFrames`.
//   2. The window JUMPS — the user pressed play at bar 9, seeked, or the loop
//      brace wrapped. Any clip that CONTAINS the new position has to start
//      partway in, or pressing play in the middle of a long take produces
//      silence until the next time its start goes by, which reads as broken.

import type { AssetId, ChannelId, ProjectSnapshot, Seconds, Ticks } from "../../types";
import type { TempoMap } from "../../types/time";
import type { WindowFiller } from "../../types/transport";
import type { AssetLibrary } from "../../types/devices";
import { PPQ } from "../../types/time";

export interface AudioClipSchedulerDeps {
  readonly ctx: BaseAudioContext;
  /** The live document, read at fill time (never captured). */
  readonly doc: () => ProjectSnapshot;
  readonly tempoMap: () => TempoMap;
  readonly assets: AssetLibrary;
  /** The head of a track's chain; `undefined` while the graph has no such
   *  channel, in which case that clip simply does not sound. */
  readonly inputFor: (channelId: ChannelId) => AudioNode | undefined;
}

export interface AudioClipScheduler extends WindowFiller {
  /** Stops everything sounding, `when` seconds on the audio clock. Called on
   *  transport stop and on any jump, so a take does not keep playing over
   *  the position the user moved to. */
  stopAll(when: Seconds): void;
  /** Live source count — diagnostics and tests. */
  playingCount(): number;
  dispose(): void;
}

interface Live {
  readonly src: AudioBufferSourceNode;
  readonly gain: GainNode;
}

function gainOfDb(db: number): number {
  return db <= -60 ? 0 : 10 ** (db / 20);
}

/**
 * Frames per tick for one asset at one tempo.
 *
 * A single tempo rather than an integral over the map: an audio file plays at
 * its own rate whatever the song does — it is not stretched — so this is only
 * used to decide WHERE IN THE FILE to start, and a tempo change mid-clip
 * moves that by a few milliseconds at worst.
 */
export function framesPerTick(sampleRate: number, bpm: number, ppq: number): number {
  return (sampleRate * 60) / (bpm * ppq);
}

export function createAudioClipScheduler(deps: AudioClipSchedulerDeps): AudioClipScheduler {
  const live = new Set<Live>();
  /** Where the last window ended, so a JUMP is recognisable. */
  let lastToTick: Ticks | null = null;
  let disposed = false;

  const start = (
    assetId: AssetId,
    trackId: ChannelId,
    gainDb: number,
    offsetFrames: number,
    when: Seconds,
    durationSeconds: number,
  ): void => {
    const buffer = deps.assets.buffer(assetId);
    const destination = deps.inputFor(trackId);
    if (buffer === undefined || destination === undefined) return;
    if (durationSeconds <= 0) return;
    const offsetSeconds = Math.max(0, offsetFrames / buffer.sampleRate);
    if (offsetSeconds >= buffer.duration) return;

    const src = deps.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = deps.ctx.createGain();
    gain.gain.value = gainOfDb(gainDb);
    src.connect(gain);
    gain.connect(destination);

    const entry: Live = { src, gain };
    live.add(entry);
    src.onended = () => {
      live.delete(entry);
      try {
        src.disconnect();
        gain.disconnect();
      } catch {
        // Already detached — a stop and an ended can race.
      }
    };
    const at = Math.max(when, deps.ctx.currentTime);
    // The clip's own end stops it: a clip trimmed shorter than its file plays
    // only what it covers, and one longer than its file simply runs out.
    src.start(at, offsetSeconds, Math.min(durationSeconds, buffer.duration - offsetSeconds));
  };

  const stopAll = (when: Seconds): void => {
    const at = Math.max(when, deps.ctx.currentTime);
    for (const entry of [...live]) {
      try {
        entry.src.stop(at);
      } catch {
        // Never started, or already stopped.
      }
    }
  };

  return {
    fillWindow(horizonSeconds: Seconds, fromTick: Ticks, toTick: Ticks): void {
      if (disposed || toTick <= fromTick) return;
      const doc = deps.doc();
      const clips = Object.values(doc.audioClips);
      const jumped = lastToTick !== null && fromTick !== lastToTick;
      const previousTo = lastToTick;
      lastToTick = toTick;
      if (clips.length === 0) return;

      const tempo = deps.tempoMap();
      const bpm = doc.tempo[0]?.bpm ?? 120;
      // `horizonSeconds` is the audio-clock time of `toTick`; everything else
      // is measured back from it, exactly as the automation sampler does.
      const secondsAt = (tick: Ticks): Seconds =>
        horizonSeconds - tempo.secondsBetween(tick, toTick);

      if (jumped) {
        // A jump: silence what was playing for the OLD position, then pick up
        // any clip that covers the new one, partway in.
        void previousTo;
        stopAll(deps.ctx.currentTime);
        for (const clip of clips) {
          if (clip.start >= fromTick || clip.start + clip.length <= fromTick) continue;
          const asset = doc.assets[clip.assetId];
          if (asset === undefined) continue;
          const intoClip = fromTick - clip.start;
          const skip = intoClip * framesPerTick(asset.sampleRate, bpm, PPQ);
          start(
            clip.assetId,
            clip.trackId,
            clip.gainDb,
            clip.offsetFrames + skip,
            secondsAt(fromTick),
            tempo.secondsBetween(fromTick, clip.start + clip.length),
          );
        }
      }

      for (const clip of clips) {
        if (clip.start < fromTick || clip.start >= toTick) continue;
        start(
          clip.assetId,
          clip.trackId,
          clip.gainDb,
          clip.offsetFrames,
          secondsAt(clip.start),
          tempo.secondsBetween(clip.start, clip.start + clip.length),
        );
      }
    },

    stopAll(when: Seconds): void {
      stopAll(when);
      // A stop is also a discontinuity: the next window must not be treated
      // as a continuation of the one before it.
      lastToTick = null;
    },

    playingCount(): number {
      return live.size;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopAll(deps.ctx.currentTime);
      live.clear();
    },
  };
}

