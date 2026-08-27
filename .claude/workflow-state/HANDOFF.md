# Fableton build — handoff (updated 2026-08-27, resumed on the 11-core box)

## Where we are

| Milestone | State |
|---|---|
| **M0 — The spine** | ✅ gated, 0 blockers, committed `9b5f7bd` |
| **M1 — Editors** | 🟢 implemented + integrated, **all known blockers fixed**, browser-verified. Review rounds not yet re-run. |
| M2 / M3 / M4 | not started |

Toolchain: `npx tsc --noEmit` clean · `npx vitest run` **1093 tests / 78 files green** ·
`npx vite build` green · `npx playwright test` **36 passed, 1 skipped, 0 failed**.

The 1 skip is `e2e/interaction/param-control.spec.ts`, a deliberate `test.fixme`
waiting on M2 to render a real param-bound control. Leave it.

## What was fixed on resume (all four verified in a real browser)

**1. `clickCount` read from `PointerEvent.detail` — BLOCKER (was known).**
The Pointer Events spec fixes `detail` at 0 on `pointerdown`/`pointerup`; the engine
listens to pointer events exclusively, so `clickCount` was permanently 1 and every
double-click verb was unreachable. Replaced with `createClickCounter()` in
`src/editor/kit/points.ts` (500ms / 5px / same-button / same-pointerType streak),
driven from the DOM binding. Nothing reads `detail` any more. 9 new unit tests.

**2. No pencil-mode control — MAJOR (was known).**
`Toolbar.tsx` now ships a Select/Pencil radio group (`tool-select-button` /
`tool-pencil-button`), `App.tsx` owns the `ToolMode` state and passes it to the
already-supporting `PianoRollPanel`. New e2e proves a drag paints a note in pencil
mode and marquees in select mode.

**3. `build:e2e` typechecked the whole repo — MINOR (was known).**
`tsconfig.json` includes `e2e`, so a type error in any spec took down the whole
Playwright harness. `build:e2e` is now `vite build --mode e2e` only. `npm run build`
still gates on `tsc --noEmit`; `npm run typecheck` is unchanged.

**4. The browser cancelled EVERY drag — BLOCKER (found on resume, was not known).**
The DOM binding never called `preventDefault()` on `pointerdown`, so Chrome started
its own default gesture, took the pointer, and fired `pointercancel` immediately
after the handler returned — no `pointermove`, no `pointerup`, ever. Every drag in
every editor aborted through `cancel()` a frame after it started and nothing could
reach `commit`. `setPointerCapture` and `touch-action: none` do NOT prevent this.
Fixed in `gestureEngine.ts`'s `onPointerDown`; focus is now taken explicitly because
`preventDefault` also suppresses focus-on-mousedown. 2 new unit tests pin both halves.

This one was invisible to unit tests by construction — jsdom cannot reproduce the
browser's pointer-takeover — which is exactly why the Playwright layer matters.

## e2e probe fixes (test-side, no app change)

The M1 probes had three bugs of their own that were masking or blocking the app
checks. Worth knowing before trusting a red run:

- **`scanColorRects` mapped canvas pixels through the CONTAINER's origin.** The
  arrangement insets its content layers by `HEADER_WIDTH_PX(132)` / `RULER_HEIGHT_PX(26)`,
  so every arrangement coordinate was 132px too far left and clip clicks landed on the
  DOM track header. Now measured from the canvas's own rect.
- **Velocity stalks counted as notes.** `theme.velocityStalk` is byte-identical to
  `theme.noteFill` (`#5aa9e6`) and shares the content layer, so an unbounded scan
  counted each deselected note twice. Added `excludeBottomCssPx` + a `scanNotes()`
  helper that bounds the scan to the note area.
- **Three specs asserted impossible preconditions:** an octave jump (192px) measured
  in a ~130px-tall note area; a "quantize" nudged to exactly half a grid cell (a
  rounding tie); and a zoom-out anchor test run at `scrollTicks: 0`, where the
  `minTick: 0` clamp legitimately wins. All three are spec fixes — the app is correct
  in each case, and each is commented with why.

`e2e/render/piano-roll-open.spec.ts` was written to assert the bug; it is now a
regression guard with updated title and framing. Its control test still pins the root
cause (`pointerdown.detail === 0` in a real browser) so the old expression cannot
come back.

## Next steps

1. Re-run M1's **verification phases only** — Contracts and both implementation waves
   are already on disk and should not be churned:
   `Workflow({ scriptPath: '.claude/workflows/m1-editors.workflow.js', args: {...} })`
   after trimming the script to start at *Browser verification*.
2. Then: `Workflow({ scriptPath: '.claude/workflows/daw-build.workflow.js',
   args: { milestones: ['M2','M3','M4'], reviewRounds: 6,
           cleanRoundsRequired: 2, gateRetries: 2 } })`

`resumeFromRunId` from the old machine is still dead — that cache was machine- and
session-local. `run-wf_bb5caff0-bc4.journal.jsonl` is kept for the record only.

## Knob notes

`reviewRounds: 4` with `cleanRoundsRequired: 2` is **unreachable** if any lens is still
dirty at round 3 — two *consecutive* clean rounds cannot fit inside the cap. M0 exited
`UNCONVERGED` for exactly this reason and still passed its gate on substance. Use
`reviewRounds: 6` to keep the same bar and make it achievable.

## Environment

Rebuilt and verified on this machine:

```bash
npm install
npx playwright install --with-deps chromium
```

**11 cores** → workflow concurrency `min(16, cores-2)` = 9. That clears the 8-core tier
the previous handoff was aiming for: the 5-lens review fan-out, the 2 browser probes and
M4's 6-device pipeline all parallelize. Max fan-out in these scripts is 7.

Headless audio/graphics facts still hold: OfflineAudioContext renders real samples ·
live AudioContext reaches `running` with `--autoplay-policy=no-user-gesture-required` ·
`AudioWorkletNode` exists · COOP/COEP → `crossOriginIsolated` + SharedArrayBuffer ·
`deviceScaleFactor: 2` → `devicePixelRatio` 2.
