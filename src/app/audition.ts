// SS10 auditions — "Auditions are UI, not transport: they play immediately
// and are never scheduled."
//
// The piano roll takes its `AuditionSink` ONCE, at creation (SS15's opaque
// component boundary), so the shell hands it a stable proxy and re-points the
// proxy instead of remounting the editor. What matters is WHEN the target is
// resolved: `ProjectEngine.auditionFor` captures the currently mounted
// instrument eagerly, and SS7's swap semantics remount the device behind a
// track's `source`. A sink resolved once and cached therefore keeps pointing
// at a disposed instance after an instrument swap — auditions go silent, and
// stay silent, because nothing remounts the piano roll to refresh the cache.
// Resolving per note keeps the proxy correct through swaps, clip changes and
// the audio boot itself.

import type { AuditionSink } from "../types";

export function createAuditionProxy(resolve: () => AuditionSink | undefined): AuditionSink {
  return {
    noteOn(pitch: number, vel: number): void {
      resolve()?.noteOn(pitch, vel);
    },
    noteOff(pitch: number): void {
      resolve()?.noteOff(pitch);
    },
    allNotesOff(): void {
      resolve()?.allNotesOff();
    },
  };
}
