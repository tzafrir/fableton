# Web DAW — Arrangement-View Composition App: Software Design

**Status:** proposed · **Rev:** 1 · **Date:** 2026-08-26
**Audience:** implementing sessions (Claude Code) + author review

Software design for a browser-based DAW modeled on Ableton Live's arrangement view: MIDI-first composition, flexible routing with groups/sends/sidechain, a first-class master chain, and automation of any control. This document fixes the architecture at the exact points where previous attempts broke, and leaves device DSP, presets, and visual design open.

---

## 1. Lessons from prior attempts → design answers

The pattern across all six failures: the previous builds wired concerns directly to each other (knob→node, track→instrument, automation→specific control). This design inserts three narrow seams — a **parameter registry**, a **routing graph + reconciler**, and a **shared canvas editor kit** — and everything else hangs off them.

| Failure area | Root cause (diagnosis) | Design answer | § |
|---|---|---|---|
| Knobs & the little things | Controls hand-built per device; drag feel, fine-adjust, reset, value display re-implemented and inconsistent | One `ParamDescriptor` model + one gesture spec, implemented once in a small control kit; every device UI composes from it | 4, 5 |
| Routing flexibility | WebAudio nodes connected imperatively at creation time; sidechain and grouping retrofitted against hard wiring | Routing lives in the **document** as data; a reconciler diffs document → live audio graph; sidechain is a first-class edge type; groups are just channels | 6 |
| Master chain | Master special-cased, so chain features diverged from track chains | Master is a `Channel` with `role:'master'`; identical strip/chain code everywhere, only its output target differs | 6 |
| MIDI clip editing details | DOM notes: layout thrash on drag, unreliable edge hit-testing, z-order churn; canvas fixed rendering but interactions stayed ad-hoc | Canvas is the committed substrate; on top, a shared editor kit — musical-unit scene model, single coordinate transform, gesture state machine, ghost-overlay previews | 9, 10 |
| Swapping instruments/effects | Device identity entangled with track wiring and UI, so replacement meant rebuilding both | Devices are descriptors instantiated behind stable ports; swap = document edit → reconciler patch with click-free ramps; clips never touched | 7 |
| Automation of arbitrary controls | Automation bolted onto specific knobs case-by-case | Anything registered as a param is automatable by construction; lanes bind a `ParamId`; playback has two paths (AudioParam ramps / control-rate messages) chosen per param | 11 |
| Adding effects later | New device = touching engine, mixer, UI, save format | New device = one definition file in a registry; panel auto-generates from params; automation, sidechain, and persistence come free | 14 |

## 2. Constraints & assumptions

**Product shape.** Arrangement view only (no session view). MIDI composition first: MIDI clips, software instruments, effect chains, mixer, automation, WAV export. Audio (sample) tracks are designed-for but deferred — the routing model treats a track's source as opaque, so an audio clip player slots in later without rework.

**Platform.** TypeScript everywhere. Evergreen desktop browsers; Chromium is the reference target, Safari and Firefox supported (Safari drives the audio-unlock and worklet-perf guardrails). Mouse/keyboard is the primary editing modality; touch gets basics (pan/zoom/select) but not gesture parity in v1. No backend: projects live locally (OPFS/IndexedDB), files are portable JSON.

**Performance budgets.** Editors hold 60 fps with ~2,000 visible notes during drag. Audio stays glitch-free with ~16 tracks / ~40 concurrent voices+effects on a mid-range laptop at the default 128-sample render quantum. Undo covers every document edit. A project must survive open→edit→save→reopen byte-stable except for edits.

**Team shape.** Small team plus AI coding sessions. This biases the design toward few, explicit seams and data-driven registration over clever indirection — a new session should be able to add an effect by imitating one file.

## 3. Architecture

Unidirectional core: input becomes **commands**, commands mutate the **document**, and the document is projected two ways — to the screen by editors/React, and to a live WebAudio graph by the **reconciler**. The engine never reaches back into the document. The **parameter registry** is the one deliberate bridge spanning UI and engine, because knob motion and automation must bypass the document's undo granularity while playing.

```
            input / gestures
                  │
  ┌───────────────▼───────────────────────┐      ┌────────────────────────┐
  │ UI · main thread                      │      │                        │
  │   React chrome · canvas editor kit    │◄┄┄┄┄┄┤                        │
  │   control kit (knobs, faders, panels) │      │     PARAM REGISTRY     │
  └───────────────┬───────────────────────┘      │   ParamId → handle     │
                  │ commands (1 gesture = 1 undo)│   descriptors · tapers │
  ┌───────────────▼───────────────────────┐      │   automated/override   │
  │ APPLICATION STATE                     │      │   state per param      │
  │   command bus · project document      │      │                        │
  │   undo history (inverse patches)      │      │   (the one sanctioned  │
  └───────────────┬───────────────────────┘      │    UI↔engine bridge)   │
                  │ subscribe (document diffs)   │                        │
  ┌───────────────▼───────────────────────┐      └───────────┬────────────┘
  │ ENGINE · main thread                  │◄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘
  │   graph reconciler · transport +      │◄┄┄ tick ┄┄ scheduler worker
  │   scheduler · automation sampler      │             (25 ms clock)
  └───────────────┬───────────────────────┘
                  │ node patches · scheduled events
  ┌───────────────▼───────────────────────┐
  │ AUDIO THREAD                          │
  │   WebAudio graph · AudioWorklets      │
  └───────────────────────────────────────┘
```

### The two write paths

There are exactly two ways anything changes at runtime, and the distinction resolves a classic DAW tension (smooth knobs vs. sane undo):

**Document path** — structural edits (add note, reorder effect, create send) go through the command bus. One user gesture = one command = one undo entry. The reconciler and editors react to document diffs.

**Param fast path** — continuous values (knob drags, automation playback) write through `ParamHandle` straight to the engine, at gesture rate, with no document churn. On gesture *release*, a single command commits the final value to the document. This is also the seam where automation *recording* attaches later: it's a tap on the same handle stream.

The reconciler is written against `BaseAudioContext`, not `AudioContext` — so bounce/export is the same engine instantiated on an `OfflineAudioContext` (§12), not a second implementation.

## 4. Parameter system  `load-bearing`

This is the spine. A parameter is a named, typed, range-bounded value with a stable id. Knobs bind to parameters. Automation lanes bind to parameters. Presets are bags of parameter values. If it isn't a parameter, it can't be automated or MIDI-mapped — so device authors are pushed to express *everything tweakable* this way.

```ts
type ParamId = string;   // "chan:g4/dev:d12/cutoff" · "chan:g4/vol" · "chan:g4/send:a"

type ParamKind = 'continuous' | 'stepped' | 'enum' | 'toggle';

interface ParamDescriptor {
  id: ParamId;
  label: string;                    // "Cutoff"
  kind: ParamKind;
  min: number; max: number;         // in real units (Hz, dB, st, %)
  defaultValue: number;
  taper?: Taper;                    // 'linear' | 'log' | { pow: k } — UI + curve mapping
  bipolar?: boolean;                // pan/detune: center detent, ± readout
  step?: number;                    // stepped kind
  labels?: string[];                // enum kind
  unit?: string;
  toText(v: number): string;        // 1200 → "1.20 kHz"
  fromText(s: string): number | null;
  smoothingMs?: number;             // default de-zipper ramp (≈15 ms) for live sets
}

interface ParamHandle {
  readonly desc: ParamDescriptor;
  readonly state: 'free' | 'automated' | 'overridden';
  base(): number;                   // committed document value
  live(): number;                   // what the DSP currently sees
  setLive(v: number, source: 'user' | 'automation'): void;
  commit(): void;                   // gesture end → one document command
  bindAudioParam(p: AudioParam): void;                       // fast path A
  bindMessage(fn: (v: number, when: number) => void): void;  // fast path B
  onChange(cb: (v: number) => void): Unsub;  // UI repaint, coalesced to rAF
}
```

**Registry and id scheme.** A single `ParamRegistry` maps `ParamId → ParamHandle`. Ids are hierarchical paths built from document ids (`chan:<id>`, `dev:<id>`), so they're stable across sessions, survive reordering, and make automation lanes and MIDI mappings serializable as plain strings. Mixer params (volume, pan, sends) register exactly like device params — which is what makes "automate anything" true rather than aspirational.

**Value semantics.** Values are stored and serialized in **real units**, not normalized 0–1. Normalization exists only at the mapping boundary: the taper maps real ↔ normalized for knob sweep and curve display. This keeps project files readable, keeps `toText` trivial, and means retuning a taper later doesn't silently rescale saved data. Loaded values clamp to the current descriptor range.

**Automated / overridden state.** Per-param state machine mirroring the Ableton behavior users expect: `free` (knob rules) → `automated` (a lane drives it; the knob displays the moving value with the base as a ghost dot) → `overridden` (user touched an automated knob during playback; automation for that param is suspended). A transport-level *Re-enable automation* pill lights when any param is overridden and restores all of them. This is UI state in the registry, not document state — it never dirties the project.

> **Design rule.** No device, mixer, or engine code ever exposes a raw `AudioParam` or setter to the UI. If a control needs to exist, a descriptor must exist. This single rule is what the previous attempts were missing when automation had to be retrofitted per-control.

## 5. Controls & knob feel

The control kit is ordinary DOM/SVG — a few dozen live controls don't need canvas; it was the *thousands of notes* that did (§10). What matters is that the gesture spec is defined once, in one place, and every control inherits it. "The little things" become a conformance table instead of folklore.

### Gesture spec (all continuous controls)

| Gesture | Behavior |
|---|---|
| Drag (vertical) | Relative mode with pointer capture: 150 px of travel = full sweep through the param's taper. No jump-to-click-point. Cursor hidden during drag, restored on release; a floating readout follows the control showing `toText(live())`. |
| `Shift` + drag | Fine mode, ×0.1 sensitivity. Can be entered/exited mid-drag without value jumps (re-anchor on modifier change). |
| Double-click | Inline numeric entry, parsed by `fromText` (accepts "1.2k", "-6db"). `Enter` commits, `Esc` cancels. |
| `Alt` + click / `Delete` (focused) | Reset to `defaultValue`. |
| Scroll wheel (hover) | Step by 1% of sweep; `Shift` = 0.1%. Wheel events consumed only while hovering the control proper. |
| Keyboard (focused) | `↑/↓` = 1%, `Shift+↑/↓` = 0.1%, `PgUp/PgDn` = 10%. Controls are tabbable with `role="slider"` + `aria-valuetext` from `toText`. |
| Right-click | Context menu: *Type value · Reset · Show/create automation lane · Copy param path* (MIDI-learn slot reserved). |
| Gesture end | Exactly one undo entry via `handle.commit()`. `Esc` mid-drag reverts to the pre-drag value, no undo entry. |

### Control inventory

| Control | Binds to | Notes |
|---|---|---|
| Knob | `continuous` | 270° sweep; value arc from min (or from center when `bipolar`). Automation state: arc shows live value in accent, small ghost dot marks `base()`; overridden = arc pulses dim. |
| Fader | `continuous` (dB taper) | Mixer volume; slim variant for sends. 0 dB detent line; drag snaps within ±0.5 dB of detent unless `Shift`. |
| Stepped knob | `stepped` | Detented drag with tick marks; wheel steps whole increments. |
| Enum select | `enum` | Segmented control ≤4 labels, dropdown above that. Automatable (stepped curve). |
| Toggle LED | `toggle` | Device on/off, sync switches. Automatable. |
| XY pad *(v2)* | 2 × `continuous` | Deferred; descriptor model already supports pairing. |

Device panels declare rows of `{ paramId, control? }`; when a definition ships no panel at all, a default panel is generated from the descriptor list (kind → control, four per row). That default is what makes "add an effect in one file" (§14) real — a new device is usable before anyone designs its face.

## 6. Routing, buses, sidechain  `load-bearing`

**Everything that carries audio is a `Channel`.** Tracks, groups, returns, and the master are the same type with a `role` tag; they all have a device chain, a fader/pan strip, sends, and an output. This one decision is what makes master chains, grouping, and "effects anywhere" fall out for free.

```ts
interface Channel {
  id: ChannelId;
  role: 'track' | 'group' | 'return' | 'master';
  source?: SourceRef;               // track only: instrument (later: audio clip player)
  chain: DeviceInstanceId[];        // ordered effects
  volume: ParamId; pan: ParamId;    // registered mixer params
  mute: boolean; solo: boolean;
  sends: { to: ChannelId; amount: ParamId; tap: 'pre' | 'post' }[];
  output: ChannelId;                // parent group, or the master; master → destination
}

interface SidechainEdge {
  from: { channel: ChannelId; tap: 'preFx' | 'postFx' | 'postFader' };
  to:   { device: DeviceInstanceId; port: 'sc' };
}
```

**Signal flow inside a channel:** `source → chain[0..n] → volume → pan → meter tap → output`, with send taps at pre-fader (post-chain) or post-fader points. Groups are channels whose input is the sum of member channels' outputs; nesting is allowed (group of groups). Moving a track into a group is a one-field document edit (`output`), which the reconciler turns into a rewire.

```
Kick ────────────────────────────────────────────────────────────┐
Bass ──[Compressor ◄╌╌ SC edge: Kick post-fader]──┐              │
Pads ──────────────────────────┐                  │              ▼
  ╎ sends (post-fader)         ▼                  ▼         ┌────────────┐
  ╎                       ┌─────────────────────────┐       │   MASTER   │
  ╎                       │      Group: Synths      │──────►│ Glue Comp  │──► ctx.destination
  ╎                       └─────────────────────────┘       │ → Limiter  │
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌►[ Return A: Reverb ]──────────────►└────────────┘
```

**Sidechain** is an explicit edge, not a device hack. A device declares an optional input port `'sc'` in its definition; the routing document may contain a `SidechainEdge` from any channel's tap point to that port. The device header UI renders an "Audio From" picker (channel + tap point) exactly like Ableton's compressor. Because edges are data, saving/loading and undo need no special cases.

**Validation.** Every routing edit (output change, send, sidechain edge) runs a DFS cycle check over the combined edge set; cycle-forming edits are rejected with an inline hint. WebAudio would technically allow some cycles via `DelayNode`, but a composition tool shouldn't — feedback routing, if ever wanted, becomes an explicit device.

**Reconciler.** `buildGraph(doc)` is a pure function producing a desired graph description (typed nodes + edges with stable ids derived from document ids). `diff(live, desired)` yields a patch: create / connect / disconnect / dispose. Patches apply with ~8 ms gain ramps at touched boundaries so chain reorders, device swaps, and regrouping are click-free; disposal is deferred until ramps and tails complete. Dynamic effect chains stop being a feature and become a diff.

**Solo / mute.** Solo is solo-in-place: a pure function computes the audible set from solo flags across the tree (respecting groups and returns fed by soloed tracks), and the engine applies it via per-channel mute gains. No routing changes, just gain — so toggling solo never pops or rebuilds anything.

**Metering.** A tiny metering worklet per strip writes peak/RMS into a `SharedArrayBuffer` slab; the UI reads it at rAF. Requires COOP/COEP headers (see §15); fallback is `AnalyserNode` polling. Meters are UI-only and never enter the document.

**Latency compensation (PDC)** is out of scope for v1, but `DeviceInstance` exposes `latencySamples()` from day one so chains can report and the reconciler can insert compensating delays later without interface changes.

## 7. Device system

A device (instrument or effect) is a **definition** — pure data plus factory — registered by id. Instances live behind stable audio ports and expose params through the registry. Nothing else in the app knows what a device does internally.

```ts
interface DeviceDefinition {
  id: string;                        // "core.compressor"
  version: number;
  kind: 'instrument' | 'audioEffect';
  label: string;
  params: ParamDescriptor[];         // ids relative to the instance
  audioIn:  PortSpec[];              // [{id:'in'}, {id:'sc', label:'Sidechain', optional:true}]
  audioOut: PortSpec[];              // [{id:'out'}]
  create(ctx: BaseAudioContext, io: DeviceIO): DeviceInstance;
  panel?: PanelSpec;                 // declarative rows; omit → auto-generated (§5)
}

interface DeviceInstance {
  connectParam(localId: string, handle: ParamHandle): void;
  noteOn?(pitch: number, vel: number, when: number): void;   // instruments
  noteOff?(pitch: number, when: number): void;
  allNotesOff?(when: number): void;
  latencySamples?(): number;         // future PDC
  dispose(when?: number): void;      // called after ramps/tails
}
```

**Lifecycle:** reconciler calls `create` → wires ports per the graph → binds each descriptor to a `ParamHandle` (which routes to an `AudioParam` or a message callback) → instance is live. Removal is the reverse, gain-ramped. Definitions may be a handful of native WebAudio nodes (filters, delays, dynamics) or an `AudioWorkletProcessor` for custom DSP (synth voices, saturation) — the interface doesn't care.

**Instrument slot.** A track's `source` is one instrument instance; the chain holds effects. The browser panel drags a definition onto a track to fill/replace the slot, or into a chain at a drop caret to insert an effect. Both are single document edits.

**Swap semantics** (the "switch instruments easily" requirement):

1. Clips are untouched — MIDI data is instrument-agnostic by construction.
2. New instance is created and connected in parallel, muted.
3. `allNotesOff` to the old instance; ~20 ms crossfade; old disposed after its tail.
4. Params carry over where the local id and range are compatible (`cutoff` → `cutoff`); everything else takes defaults.
5. Automation lanes targeting the old instance's params are **kept, greyed, and re-bindable** — never silently deleted. A lane can be pointed at any param of the replacement in two clicks.

**Versioning.** `version` on the definition plus per-device migration functions (`migrateParams(old)`) keep saved projects loading as DSP evolves. Param local-ids are treated as public API: renaming one requires a migration.

## 8. Musical time model

All musical positions and lengths are **integer ticks** at 960 PPQ (`type Ticks = number`, always integer). Seconds never appear in the document.

Why: seconds would rescale under tempo changes; floating beats accumulate drift and break equality/snap tests. Integer ticks make note math exact, serialization stable, and grid logic trivial (a 1/16 at 960 PPQ is exactly 240 ticks).

A `TempoMap` — list of `(tick, bpm)` segments — owns tick↔seconds conversion via piecewise integration. v1 ships a single fixed-tempo segment, but every engine API takes the map, so tempo automation later is a data change, not a refactor. Conversion happens in exactly two places: the scheduler (ticks → `AudioContext` seconds) and the time ruler (formatting `bar.beat.tick`).

## 9. Canvas editor kit  `load-bearing`

The arrangement lanes, piano roll, and automation lanes are three skins over one framework. This is the answer to "canvas fixed rendering but editing was still painful": the kit owns coordinates, hit-testing, gestures, and previews so each editor only supplies its scene and its verbs.

**Coordinate discipline.** Editor logic runs in musical units (ticks, pitch, param value) — pixels exist only at the boundary. One shared `Viewport` object per editor holds the transform:

```ts
interface Viewport {
  pxPerTick: number; scrollTicks: number;         // horizontal (shared feel everywhere)
  pxPerRow: number;  scrollRows: number;          // vertical (pitch, tracks, or value axis)
  xOf(t: Ticks): number;  tAt(x: number): Ticks;  // + yOf / rowAt
  zoomAt(px: number, factor: number): void;       // keeps time under cursor fixed
}
```

Scroll/zoom is uniform across editors: wheel = vertical, `Shift`+wheel = horizontal, `Ctrl/Cmd`+wheel and pinch = zoom-to-cursor.

**Rendering stack.** Layered per editor, each redrawn only when its inputs change (dirty flags, drawn on rAF):

1. **Grid layer** — bars/beats/rows; redraws on viewport change only.
2. **Content layer** — notes / clips / breakpoints; redraws on data or viewport change.
3. **Overlay layer** — selection, marquee, drag ghosts; the only layer redrawing at 60 fps during a gesture.
4. **Playhead** — a 1-px DOM element moved via `transform: translateX()`, so playback never forces canvas repaints.

All canvases render at `devicePixelRatio` with lines aligned to half-pixels for crispness. Content culls to the viewport: notes are kept sorted by start tick, and the visible window is found by binary search — O(visible) per frame, comfortably inside the 2,000-note budget.

**Gesture state machine.** The kit runs one FSM per editor over pointer events; editors register hit-testers and drag handlers. Every drag operates on a **preview** (ghosts in the overlay) and commits exactly one command on release; `Esc` aborts with zero document traffic. This is what makes editing feel native: thresholds, capture, snapping, and cancellation live in one tested place.

## 10. Piano roll

The heart of the app, and where the previous attempt bled. Data model first:

```ts
interface Note   { id: NoteId; start: Ticks; dur: Ticks; pitch: number /*0–127*/; vel: number /*1–127*/; muted?: boolean; }
interface MidiClip { id: ClipId; trackId: ChannelId; start: Ticks; length: Ticks;
                     loop?: { start: Ticks; end: Ticks }; notes: Note[]; }
```

### Hit zones

Hover resolves to a zone before any button is pressed, and the cursor reflects it:

- **Body** — move. Left/right **edge zones**: `min(6 px, 40% of note width)` each side, so short notes always keep a grabbable body.
- **Velocity lane** (bottom strip): each note draws a stalk; drag sets velocity, marquee-drag sets many, `Alt`+vertical-drag on selected note bodies adjusts velocity without leaving the grid.
- Empty grid — marquee (or note creation in pencil mode / double-click).

### Gesture FSM

| State | Entered by | On move | On release | Esc |
|---|---|---|---|---|
| `Idle` | — | update hover zone + cursor | — | clear selection |
| `Pending` | pointerdown | >3 px → promote per zone (`Alt`+body → `DragDup`) | click: select (`Shift` adds, `Ctrl` toggles); dbl-click empty: create grid-length note | cancel |
| `DragMove` | body | ghosts at snapped Δtick/Δpitch; audition on pitch change | one command: move n notes | revert |
| `DragResizeL/R` | edge | ghost lengths; floor = 1/128 note | one command: resize | revert |
| `DragDup` | `Alt`+body | ghosts of copies | one command: duplicate+move | revert |
| `Marquee` | empty | live rect-intersect selection | commit selection (not undoable) | cancel |
| `DragVel` | velocity stalk | set velocity for stalks in x-range | one command | revert |
| `Paint` | pencil drag | create note, extend while dragging right | one command per note | revert |

### Keyboard map (selection-centric)

| Keys | Action |
|---|---|
| `↑` / `↓` | transpose ±1 semitone (auditions at new pitch) |
| `Shift+↑/↓` | transpose ±1 octave |
| `←` / `→` | move by current grid |
| `Shift+←/→` | fine nudge (1/64 note) |
| `Alt+←/→` | shorten / lengthen by grid |
| `Cmd/Ctrl+D` | duplicate selection immediately after itself |
| `Cmd/Ctrl+A` | select all in clip |
| `Delete` | delete selection |
| `0` | mute/unmute selected notes |
| `Cmd/Ctrl+U` | quantize starts to grid |
| `Esc` | cancel drag → clear selection |

Every action goes through the same commands the mouse uses — the keyboard is a first-class client of the editor, not a bolt-on.

### Snapping

Grid is adaptive to zoom (as in Live) with a fixed-grid override menu and a triplet toggle. **Moves are relative**: dragging or arrow-moving shifts notes in grid increments from their original position, preserving off-grid offsets; absolute snap applies only when creating. `Alt` while dragging bypasses snap entirely. Resize snaps the moving edge, never the anchored one.

### Why DOM failed, for the record

Hundreds of absolutely-positioned divs re-laid-out per drag frame; `elementFromPoint` can't express edge zones or tolerance; z-order churn during overlap; sub-pixel borders shimmer. Canvas + explicit hit-testing turns all of that into ordinary math against the note model. Controls stay DOM (§5); anything with unbounded element count goes canvas.

## 11. Automation

```ts
interface AutoPoint      { t: Ticks; v: number; curve: number /* −1..1 segment bend */; }
interface AutomationLane { id: LaneId; paramId: ParamId; points: AutoPoint[]; enabled: boolean; }
```

Lanes hang off the channel that owns the target param and render as expandable rows under the track in the arrangement (kit editor #3). Values are real units (§4); the vertical axis maps through the param's taper so a log-taper cutoff sweep looks straight when it sounds straight.

**Editing** reuses the kit verbatim: click a segment to add a point, drag a point (snap on time axis only), drag a segment's middle to bend `curve`, marquee + the same keyboard nudges. Stepped/enum/toggle params render and edit as steps.

**Playback — two paths, chosen by the binding (§4):**

- *AudioParam path:* the automation sampler converts each look-ahead window (§12) into `setValueAtTime` + `linearRampToValueAtTime`, sampling bent segments into short `setValueCurveAtTime` chunks. Live edits during playback call `cancelAndHoldAtTime` from the edit point and reschedule the remainder of the window.
- *Message path:* for worklet params and discrete settings, sample at 200 Hz control rate into timestamped messages; the worklet interpolates between them. Enum/toggle changes apply exactly at segment boundaries.

**Interaction with the knob** is the §4 state machine: an enabled lane puts the param in `automated`; touching the control during playback flips it to `overridden` until *Re-enable automation*. Deleting a lane frees the param; disabling keeps the data inert.

Because sends, volume, pan, and every device param are registry entries, "automation for arbitrary controls" has no additional surface — the lane-creation menu is literally a filtered view of the registry (plus tempo, which targets the TempoMap and is deferred per §16).

## 12. Transport & scheduling

Classic two-clock design. `AudioContext.currentTime` is the only truth for *when*; JS timers only decide *how far ahead* to schedule.

```ts
// runs in a dedicated Worker (main-thread timers throttle in background tabs)
setInterval(() => post('tick'), 25);

// engine, on each tick:
const horizon = ctx.currentTime + 0.20;                  // 200 ms look-ahead
for (const ev of events.until(horizon)) schedule(ev);    // noteOn/Off → instrument
autoSampler.fillWindow(horizon);                         // §11 ramps/messages
```

The event iterator walks clips in tick order, unrolling clip loops and the transport loop brace on the fly; song-position ↔ seconds goes through the TempoMap (§8). Note events call `instrument.noteOn(pitch, vel, when)` with exact context timestamps, so jitter in the tick loop never reaches the audio. The playhead is UI-only: rAF maps `currentTime` back to ticks and translates the DOM playhead (§9).

Transport states: `stopped → playing → recording` (record = playing + capture flag for later MIDI input). Stop sends `allNotesOff(now + ε)` down every track. Metronome and count-in are scheduled like any other events, targeting a built-in click instrument on a hidden channel.

**Export.** Instantiate the same document on an `OfflineAudioContext` (reconciler already targets `BaseAudioContext`), run the scheduler in fill-everything mode, `startRendering()`, encode WAV in a worker. MP3/OGG later via a WASM encoder. Stem export = same render with per-channel taps.

**Guardrails:** `latencyHint:'interactive'`; resume the context on first user gesture (Safari); zero allocation in per-tick paths (preallocated event objects, ring buffers for messages).

## 13. State, undo, persistence

The document is plain serializable data behind a small store. All structural edits are **commands**; execution produces immer-style patches, and inverse patches make undo/redo mechanical. Continuous gestures stay on the param fast path (§3) and contribute exactly one command at release. Selection, viewport, and meters are ephemeral state outside the document — never undoable, never saved into history.

```ts
interface Command { label: string; run(doc: Draft<Project>): void; }
// dispatch(cmd) → { patches, inverse } → history.push → subscribers get diffs
```

The reconciler and editors subscribe to patch streams, so reacting to "effect moved from chain[2] to chain[0]" is a targeted update, not a full re-scan.

**Persistence.** Project = versioned JSON (`schemaVersion` + ordered migrations, same discipline as device versions in §7). Autosave debounced ~2 s to OPFS; explicit export/import of `.json` project files. Samples and presets (when they arrive) are stored content-addressed (hash → blob) in OPFS with the project referencing hashes, keeping project files small and copies cheap.

## 14. Extensibility playbook

The acceptance test for this whole architecture: **adding an effect is one file**. Here is the entire cost of a stereo delay —

```ts
export const StereoDelay: DeviceDefinition = {
  id: 'core.stereo-delay', version: 1, kind: 'audioEffect', label: 'Stereo Delay',
  audioIn: [{ id: 'in' }], audioOut: [{ id: 'out' }],
  params: [
    p.time('timeL', 'Time L', { min: 1, max: 2000, defaultValue: 250 }),   // ms, log taper
    p.time('timeR', 'Time R', { min: 1, max: 2000, defaultValue: 375 }),
    p.pct('feedback', 'Feedback', { defaultValue: 35, max: 95 }),
    p.pct('mix', 'Mix', { defaultValue: 25 }),
  ],
  create(ctx, io) {
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const dl = ctx.createDelay(2), dr = ctx.createDelay(2);
    const fb = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
    io.in.connect(dry).connect(io.out);
    io.in.connect(split);
    split.connect(dl, 0); split.connect(dr, 1);
    dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
    merge.connect(fb).connect(split);            // shared feedback
    merge.connect(wet).connect(io.out);
    return deviceInstance({
      audioParams: { timeL: dl.delayTime, timeR: dr.delayTime },  // + ms→s scaler
      gainParams:  { feedback: fb, mix: [wet, dry] },             // mix = equal-power pair
      dispose: (when) => rampOutAndDisconnect(when, [dry, wet]),
    });
  },
};
registry.register(StereoDelay);
```

What arrives with zero further work: a generated panel with correctly-tapered knobs and the full §5 gesture spec; four automatable params visible in every lane menu; drag-insert into any chain including groups and master; serialization; undo. Declaring `{ id:'sc', optional:true }` in `audioIn` would additionally make it a sidechain target in the routing UI.

**Adding an instrument** is the same shape plus a voice layer: an `AudioWorkletProcessor` (or node-per-voice graph for simple synths), a voice allocator behind `noteOn/noteOff/allNotesOff`, params wired via `connectParam`, register. The scheduler, piano roll, swap flow, and automation already know how to talk to it.

Helper library `p.*` (param descriptor factories: `p.db`, `p.hz`, `p.ms`, `p.pct`, `p.st`, `p.enum`) keeps descriptors one-liners and tapers/formatting consistent across the whole device library.

## 15. Stack & alternatives considered

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Audio layer | Raw Web Audio + AudioWorklets | Tone.js | We need to own the scheduler, graph identity, and reconciliation; Tone's Transport/bus abstractions fight the document→graph model and leak on dynamic rewiring. Its instruments remain a reference, not a dependency. |
| Editor rendering | Canvas 2D + own kit (§9) | PixiJS / WebGL | 2D easily meets the 2k-note budget with culling; zero deps and full control over hit-testing. `Renderer` is an interface, so a WebGL backend can slot in if profiling ever demands it. |
| App chrome | React (chrome only) | React-rendered notes/clips | Prior failure; DOM is reserved for bounded-count UI. Editors mount as opaque canvas components with an imperative bridge. |
| UI state | Zustand for ephemeral state only | Redux for everything | The document already has its own command/patch store (§13); duplicating it in a global UI store caused sync bugs before. |
| Automation values | Real units | Normalized 0–1 | Readable files, taper edits don't rescale data, `toText` stays trivial (§4). |
| History | Command + inverse patches (immer) | Event sourcing / CRDT | Single-user v1; patches are simple and fast. Patch streams are CRDT-wrappable if collaboration ever lands. |
| Build | Vite + TS strict, Vitest; worklets as separate entry points | — | Worklet bundling is the only nonstandard bit; solve once in M0. |

Testing leans on the seams: the engine runs headless against `OfflineAudioContext` in integration tests (schedule a clip, render, assert on the buffer); gesture FSMs are unit-tested by feeding synthetic pointer-event sequences; reconciler tests diff document fixtures and assert patch sets — no browser needed for any of the load-bearing logic.

## 16. Open questions

- **Tempo automation** — the TempoMap is designed for it (§8); is a tempo lane v1.x or later? Affects only the ruler and scheduler integration windows.
- **Audio tracks & warping** — the `source` slot is reserved (§6), but time-stretch quality/scope needs its own design pass before committing.
- **PDC trigger point** — first device with real latency (lookahead limiter?) forces the compensation pass; schedule it with that device, not speculatively.
- **Preset carry-over on swap** — beyond same-id params (§7), is fuzzy matching (label/unit) worth it, or does it create surprises?
- **Touch editing depth** — which piano-roll gestures get touch equivalents beyond pan/zoom/select, and does long-press replace right-click?
- **Freeze / bounce-in-place** — offline-render a track to a hidden audio clip; depends on audio-track groundwork.
- **MIDI input & mapping** — Web MIDI for live input and MIDI-learn is v1.x; the registry already reserves the mapping slot (§5).

## 17. Out of scope (v1)

Audio recording and warping · session view · third-party plugin hosting (VST/CLAP or param-server bridges) · collaboration/multiplayer · MPE and per-note expression · PDC · mobile *editing* (viewing/playback only) · cloud storage.

## 18. Milestones

Each milestone ships something playable and proves a seam end-to-end.

**M0 — The spine.** Context boot + unlock, ParamRegistry, one poly synth + one filter effect as definitions, transport with look-ahead scheduler, a hard-coded clip audible through a hard-coded chain. *Proves: params, devices, scheduling.*

**M1 — Editors.** Arrangement lanes (clip create/move/trim/split/loop), full piano-roll spec (§10), undo everywhere, save/load. *Proves: editor kit, command/undo, persistence.*

**M2 — Mixer & routing.** Channel strips, groups (incl. nesting), sends/returns, sidechain edges + "Audio From" UI, master chain, solo-in-place, meters. *Proves: routing document + reconciler under live rewiring.*

**M3 — Automation.** Lanes, curve editing, both playback paths, override/re-enable, automation of mixer params. *Proves: the registry earns its place.*

**M4 — Library & finish.** 6–8 core devices via the playbook (compressor with SC, EQ, delay, reverb, saturator, second instrument), presets, WAV export, project-format hardening. *Proves: extensibility is real — measured by how little of M0–M3 code M4 touches.*

---
*rev 1 · 2026-08-26 · single-direction spec per prior-attempt post-mortems · next rev: after M0 findings*
