# Fableton build — final state (2026-08-27)

## All milestones implemented

| Milestone | State |
|---|---|
| **M0 — The spine** | ✅ `9b5f7bd` (workflow-built, gated) |
| **M1 — Editors** | ✅ `269cc44` + `4141291` (workflow-built; 4 hand-fixed blockers; 2 adversarial review rounds applied — 50 findings fixed) |
| **M2 — Mixer & routing** | ✅ `117c87a` + `fa57f9d` (direct build) |
| **M3 — Automation** | ✅ `3a3e722` (direct build) |
| **M4 — Library & finish** | ✅ `bcad3f2` (direct build) |

Toolchain: `npx tsc --noEmit` clean · **1305 unit tests / 95 files green** ·
`npx vite build` green · `npx playwright test` **54 passed / 0 skipped / 0 failed**
across render, interaction, audio, mixer, automation and library suites.

M1 was built by the milestone workflow and hardened by its review loop; M2–M4
were implemented directly in-session (user decision, 2026-08-27) with review
deferred. Every milestone ships unit + e2e coverage written alongside it.

## Deliberate deviations from PLAN.md (all commented at the code site)

1. **Automation lanes live in their own bottom-pane tab**, not as expandable
   arrangement rows (SS11 drew them under tracks). M1 froze the arrangement's
   row convention as `row = channelOrder index`; same kit, same verbs,
   different placement. `src/editor/automation/view.ts` header documents it.
2. **Bent segments schedule as dense `linearRampToValueAtTime` chunks**, not
   `setValueCurveAtTime` (same audible result, none of that call's overlap
   restrictions). `src/engine/automation/sampler.ts` header.
3. **Self-keying sidechains are rejected** (device keyed from its own channel
   = a mute-the-graph WebAudio cycle); the SS6 cycle check covers them.
4. **Presets persist to localStorage** (memory fallback) rather than the
   content-addressed OPFS store the plan sketches for samples — that store
   arrives with samples. `src/presets/store.ts` header.
5. **Chain reorder is ◀/▶ buttons**, not drag-and-drop (SS7's "drop caret");
   same commands underneath.

## Review debt (user chose to defer)

M2–M4 have NOT been through an adversarial review loop or an independent
acceptance gate. When reviewing, the M1-verify workflow's phases
(`.claude/workflows/m1-verify.workflow.js`, from *Adversarial review* on) are
reusable shape; ground truth is docs/PLAN.md SS4–SS7, SS11–SS12, SS14, SS18.

## Environment

11 cores · Playwright chromium installed · dev server convention: 5173
(user's Docker port mapping; `--strictPort`), Playwright owns 4173.
