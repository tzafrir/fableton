// M1's migration of M0's hard-coded clip (SS3: "the document is the source of
// truth"; SS18-M1: the scheduler plays what the document says, not a chain
// wired at boot).
//
// M0 proved audio by handing the transport a `MidiClip` constant
// (`./clip.ts`) through a chain assembled at boot in `./engine.ts`. In M1 the
// same phrase is expressed as a real `Project`: a track whose `source` names
// the default instrument, one clip, eight notes. Nothing plays it specially —
// `ProjectEngine.applyDocument` mounts the instrument the document asks for
// and `DocumentNoteEventSource` scans the document's clips (src/app/engine),
// exactly as it does for a phrase the user drew in the piano roll. That is
// the whole point: after this migration there is no "demo path" left in the
// audible chain, only a document.
//
// It is also the app's STARTER PROJECT: `src/app/persistence.ts` uses it as
// the first-run fallback for `loadOrCreateProject` (SS13), so a fresh session
// opens something audible and Boot -> Play proves the document -> scheduler
// seam end to end (SS18: "each milestone ships something playable"). Once a
// session has autosaved, that autosave wins; "New" still gives the user
// `createEmptyProject`'s empty document.

import { createEmptyProject } from "../state";
import type { CreateEmptyProject, Note, Project } from "../types";
import { DEMO_CLIP } from "./clip";

const DEMO_PROJECT_NAME = "Demo Phrase";

/**
 * `createEmptyProject`'s document with M0's arpeggio written into its clip —
 * built by copying notes into the empty project rather than by hand, so the
 * fixture inherits every document invariant that package already guarantees
 * (one master, `channelOrder` a permutation, mixer params seeded, ...).
 *
 * Typed as `CreateEmptyProject` so it is a drop-in for the factory
 * `loadOrCreateProject` takes (SS13) — including the deterministic `ids`
 * option, which is what lets a spec predict what it is looking at.
 */
export const createDemoProject: CreateEmptyProject = (options = {}): Project => {
  const base = createEmptyProject({ ...options, name: options.name ?? DEMO_PROJECT_NAME });

  const clipId = Object.keys(base.clips)[0];
  if (clipId === undefined) throw new Error("createEmptyProject produced no clip");
  const clip = base.clips[clipId];
  if (clip === undefined) throw new Error("createEmptyProject produced no clip");

  // Notes stay sorted by (start, pitch) — DEMO_CLIP is already in that order
  // (invariant 4), and copied so the document never aliases the constant.
  const notes: Note[] = DEMO_CLIP.notes.map((note) => ({ ...note }));

  return {
    ...base,
    clips: { [clipId]: { ...clip, length: DEMO_CLIP.length, notes } },
  };
};
