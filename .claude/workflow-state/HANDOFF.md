# Fableton build — handoff (paused 2026-08-27)

Paused mid-**M1** to move to an 8-core Codespace. Everything below is committed.

## Where we are

| Milestone | State |
|---|---|
| **M0 — The spine** | ✅ gated, 0 blockers, committed `9b5f7bd` |
| **M1 — Editors** | 🟡 implemented + integrated, **1 known blocker**, review round 1 was in flight when paused |
| M2 / M3 / M4 | not started |

Toolchain at pause: `npx tsc --noEmit` clean · `npx vitest run` **1083 tests / 78 files, all green** · `npx vite build` green.

## KNOWN BLOCKER — fix this first

`src/editor/kit/points.ts`

```ts
clickCount: event.detail === 0 ? 1 : event.detail   // BUG
```

`PointerEvent.detail` is **always 0** on `pointerdown` in every standards-compliant
browser, so double-click detection never fires and **no clip can be opened into the
piano roll**. Found independently by both M1 Playwright probes; it transitively failed
7 of 8 interaction checks (drag-move, edge-resize, Alt-duplicate, marquee, Esc-cancel,
undo-as-one-entry, keyboard map, zoom-at-cursor, OPFS round-trip).

It passes `tsc`, all 1083 unit tests, and `vite build` — unit tests feed synthetic
pointer events with `detail` set by hand, so they are structurally blind to it. Track
click count from `pointerdown` timing/position instead of `event.detail`.

**Second finding (major):** `src/app/panels/Toolbar.tsx` ships no control to switch the
piano roll into `pencil` ToolMode, and `App.tsx` never passes one — pencil-mode note
creation is unreachable in the shipped app.

**Third (minor):** `npm run build` runs a project-wide `tsc --noEmit` before `vite build`,
and that command is also the first half of `playwright.config.ts`'s `webServer`. A
typecheck error anywhere in the repo therefore takes down the entire e2e harness.

The Playwright specs asserting all of the above are already on disk under
`e2e/interaction/` and `e2e/render/` — they will prove the fix without being rewritten.

## Resuming on the new machine

**`resumeFromRunId` will NOT work.** The workflow cache lives at
`~/.claude/projects/<project>/<session-uuid>/subagents/workflows/wf_bb5caff0-bc4/`,
which is machine- and session-local. A new Codespace has neither. The run journal is
preserved here as `run-wf_bb5caff0-bc4.journal.jsonl` for the record only (332K, one
line per completed agent with its structured result) — it is not a usable resume cache.

The real state is the committed working tree, and it is substantially complete for M1.

Recommended path, in order:

1. Fix the three findings above by hand — they are small, well-localized, and already
   diagnosed. Re-run `npx playwright test` to confirm against the existing specs.
2. Then run M1's remaining verification phases rather than the whole milestone, so the
   implementers don't churn code that already works:
   `Workflow({ scriptPath: '.claude/workflows/m1-editors.workflow.js', args: {...} })`
   — but first trim the script to start at *Browser verification*, since Contracts and
   the two implementation waves are already on disk.
3. Then continue normally:
   `Workflow({ scriptPath: '.claude/workflows/daw-build.workflow.js',
               args: { milestones: ['M2','M3','M4'], reviewRounds: 6,
                       cleanRoundsRequired: 2, gateRetries: 2 } })`

## Knob notes for next time

`reviewRounds: 4` with `cleanRoundsRequired: 2` is **unreachable** if any lens is still
dirty at round 3 — two *consecutive* clean rounds cannot fit inside the cap. M0 exited
`UNCONVERGED` for exactly this reason and still passed its gate on substance. Use
`reviewRounds: 6` to keep the same bar and make it achievable.

## Environment (rebuild on the new machine)

Playwright is **not** a repo dependency of the harness by default — reinstall it:

```bash
npm install
npx playwright install --with-deps chromium
```

Verified working headlessly on the old machine (re-verify if anything looks off):
OfflineAudioContext renders real samples (440 Hz sine → RMS ~0.5) · live AudioContext
reaches `running` with `--autoplay-policy=no-user-gesture-required` · `AudioWorkletNode`
exists · COOP `same-origin` + COEP `require-corp` → `crossOriginIsolated` and
SharedArrayBuffer available (needed for §6 metering) · `deviceScaleFactor: 2` →
`devicePixelRatio` 2 for DPR canvas checks.

## Machine sizing

Workflow concurrency is `min(16, cores − 2)`. 2 cores → 2. **4 cores → still 2.** 8 cores
→ 6, which is the first tier that actually parallelizes the 5-lens review fan-out, the
2 browser probes, and M4's 6-device pipeline. Max fan-out in these scripts is 7.
