/*
 * m1-verify.workflow.js — Milestone M1 "Editors", VERIFICATION PHASES ONLY.
 *
 * Derived from m1-editors.workflow.js by removing Contracts, both
 * implementation waves and Integration: those are already on disk and must not
 * be churned. Everything from Browser verification onward is byte-identical to
 * the full script, so the bar is unchanged.
 *
 * Context this run starts from (2026-08-27): M1 was implemented and integrated,
 * then four interaction blockers were fixed by hand and committed (269cc44) —
 * `PointerEvent.detail`-derived clickCount, a missing pointerdown
 * preventDefault that let the browser cancel EVERY drag, a missing pencil-mode
 * control, and an e2e build coupled to a repo-wide typecheck. Three bugs in the
 * e2e probes themselves were fixed too. Tree state at launch: tsc clean,
 * 1093 unit tests green, vite build green, playwright 36 passed / 1 skipped.
 *
 * Run:
 *   Workflow({ scriptPath: '/workspace/fableton/.claude/workflows/m1-verify.workflow.js',
 *              args: { reviewRounds: 6, cleanRoundsRequired: 2, gateRetries: 2 } })
 *
 * Args: reviewRounds (3), cleanRoundsRequired (1), gateRetries (1),
 *       budgetReserve (0), commitOnPass (true), maxFindingsPerFix (30).
 * Returns: { milestone, pass, blockers, evidence, reviewRoundsUsed,
 *            convergedClean, gateAttempts }
 */

export const meta = {
  name: 'daw-m1-verify',
  description: 'M1 Editors, verification only: browser probes, adversarial review, completeness critic, independent opus acceptance gate. Implementation is already on disk and is not rebuilt.',
  phases: [
    { title: 'Browser verification', model: 'sonnet' },
    { title: 'Adversarial review' },
    { title: 'Completeness critic', model: 'opus' },
    { title: 'Acceptance gate', model: 'opus' },
    { title: 'Checkpoint', model: 'sonnet' },
  ],
};

// ---- model policy (user-mandated) ------------------------------------------
// NO FABLE AGENTS anywhere in this build (out of fable budget for this project).
// The final acceptance gate is a FRESH opus agent that only verifies -- it never
// implements, and it runs only after the opus review/fix loop has converged.
const M = { code: 'sonnet', smart: 'opus', gate: 'opus' };

const MILESTONE = 'M1';
const TITLE = 'Editors';
const ROOT = '/workspace/fableton';
const PLAN = ROOT + '/docs/PLAN.md';
const CRITIC_SECTIONS = 'SS3, SS9, SS10, SS13, SS15 (testing), SS18-M1';

const A = args || {};
const REVIEW_ROUNDS = A.reviewRounds ?? 3;
const CLEAN_NEEDED = A.cleanRoundsRequired ?? 1;
const GATE_RETRIES = A.gateRetries ?? 1;
const RESERVE = A.budgetReserve ?? 0;
const COMMIT_ON_PASS = A.commitOnPass ?? true;
const MAX_FIX = A.maxFindingsPerFix ?? 30;

const PH = {
  contracts: 'Contracts',
  wave1: 'Implement: kit & state',
  wave2: 'Implement: editors & shell',
  integration: 'Integration',
  browser: 'Browser verification',
  review: 'Adversarial review',
  critic: 'Completeness critic',
  gate: 'Acceptance gate',
  checkpoint: 'Checkpoint',
};

function budgetAllows() {
  if (!budget.total) return true;
  return budget.remaining() > RESERVE;
}

// ---- shared schemas --------------------------------------------------------
const FINDING = {
  type: 'object', required: ['severity', 'file', 'description'],
  properties: {
    severity: { enum: ['blocker', 'major', 'minor'] },
    file: { type: 'string' }, description: { type: 'string' },
    planSection: { type: 'string' }, lens: { type: 'string' },
  },
};
const IMPL_SCHEMA = {
  type: 'object', required: ['pkg', 'filesWritten', 'tscClean', 'testsPassed', 'summary'],
  properties: {
    pkg: { type: 'string' }, filesWritten: { type: 'array', items: { type: 'string' } },
    tscClean: { type: 'boolean' }, testsPassed: { type: 'boolean' },
    summary: { type: 'string' }, planSectionsCited: { type: 'array', items: { type: 'string' } },
  },
};
const REVIEW_SCHEMA = {
  type: 'object', required: ['lens', 'verdict', 'findings'],
  properties: { lens: { type: 'string' }, verdict: { enum: ['clean', 'defects'] }, findings: { type: 'array', items: FINDING } },
};
const FIX_SCHEMA = {
  type: 'object', required: ['fixed', 'rejected', 'tscClean', 'testsPassed'],
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    rejected: { type: 'array', items: { type: 'object', required: ['finding', 'reason'], properties: { finding: { type: 'string' }, reason: { type: 'string' } } } },
    tscClean: { type: 'boolean' }, testsPassed: { type: 'boolean' },
  },
};
const INTEGRATION_SCHEMA = {
  type: 'object', required: ['tscClean', 'testsPassed', 'buildOk', 'summary'],
  properties: {
    tscClean: { type: 'boolean' }, testsPassed: { type: 'boolean' }, buildOk: { type: 'boolean' },
    changes: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' },
  },
};
const BROWSER_SCHEMA = {
  type: 'object', required: ['probe', 'ran', 'consoleErrors', 'checks', 'findings'],
  properties: {
    probe: { type: 'string' }, ran: { type: 'boolean' },
    consoleErrors: { type: 'array', items: { type: 'string' } },
    screenshots: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'object', required: ['check', 'result'], properties: { check: { type: 'string' }, result: { enum: ['pass', 'fail', 'blocked'] }, note: { type: 'string' } } } },
    findings: { type: 'array', items: FINDING },
    summary: { type: 'string' },
  },
};
const CRITIC_SCHEMA = {
  type: 'object', required: ['gaps'],
  properties: {
    gaps: { type: 'array', items: { type: 'object', required: ['area', 'description', 'severity'], properties: { area: { type: 'string' }, description: { type: 'string' }, severity: { enum: ['blocker', 'major', 'minor'] }, planSection: { type: 'string' } } } },
    summary: { type: 'string' },
  },
};
const GATE_SCHEMA = {
  type: 'object', required: ['pass', 'blockers', 'evidence'],
  properties: { pass: { type: 'boolean' }, blockers: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string' } },
};
const CONTRACT_SCHEMA = {
  type: 'object', required: ['interfaceFiles', 'notes'],
  properties: {
    interfaceFiles: { type: 'array', items: { type: 'string' } },
    extraOwnership: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
    notes: { type: 'string' },
  },
};

// ---- work packages ---------------------------------------------------------
const WAVE1 = [
  { id: 'canvas-kit', model: M.smart, effort: 'high', own: ['src/editor/kit/'],
    sections: 'SS9 (all of it), SS2 (60fps/2000-note budget)',
    brief: 'THE load-bearing editor seam. Viewport (pxPerTick/scrollTicks/pxPerRow/scrollRows, xOf/tAt/yOf/rowAt, zoomAt keeping time under cursor fixed); uniform wheel bindings (wheel=vertical, Shift+wheel=horizontal, Ctrl/Cmd+wheel and pinch=zoom-to-cursor); four-layer rendering stack (grid/content/overlay/DOM playhead) with dirty flags on rAF, devicePixelRatio-aware, half-pixel-aligned lines; binary-search culling over start-tick-sorted content; the shared gesture FSM engine (pointer capture, promotion threshold, ghost previews in overlay, exactly one command on release, Esc aborts with zero document traffic) with editor-registered hit-testers and drag handlers. Unit-test the FSM engine and Viewport math headlessly with synthetic pointer sequences (SS15).' },
  { id: 'command-undo', model: M.smart, effort: 'high', own: ['src/state/'],
    sections: 'SS13, SS3 (document path), SS6/SS10 (document shapes needed now)',
    brief: 'THE state seam. Project document store: plain serializable data; Command interface with immer-draft run(); dispatch producing {patches, inverse}; history push with undo/redo; patch-stream subscription so editors/reconciler get targeted diffs; selection/viewport/meters kept OUTSIDE the document (ephemeral, Zustand per SS15). Define the v1 project document: channels (track role only for now), MidiClips with Notes (SS10 data model), plus what M0 needs to play from the document instead of a hard-coded clip. Round-trip unit tests: patches invert exactly.' },
  { id: 'persistence', model: M.code, own: ['src/persist/'],
    sections: 'SS13 (persistence), SS2',
    brief: 'Versioned JSON project files: schemaVersion + ordered-migrations scaffold (v1 has one migration slot, the discipline matters); OPFS autosave debounced ~2s; explicit export/import of .json; open->edit->save->reopen byte-stable-except-edits test with an in-memory OPFS stub for headless testing.' },
];
const WAVE2 = [
  { id: 'piano-roll', model: M.smart, effort: 'high', own: ['src/editor/pianoroll/'],
    sections: 'SS10 (every table, verbatim), SS9, SS8',
    brief: 'The heart of the app, as a kit skin. Hit zones incl. min(6px, 40% of width) edges and the velocity lane stalks; the FULL gesture FSM table (Idle/Pending/DragMove/DragResizeL-R/DragDup/Marquee/DragVel/Paint) with per-row on-move/on-release/Esc semantics; the FULL keyboard map (transpose, octave, grid moves, fine nudge, lengthen/shorten, duplicate, select-all, delete, mute, quantize, Esc) driving the same commands as the mouse; snapping: adaptive grid with fixed override + triplet toggle, RELATIVE moves preserving off-grid offsets, absolute snap only on create, Alt bypasses snap, resize snaps the moving edge only; audition notes on pitch change during drag. Exhaustive FSM unit tests from synthetic pointer sequences (SS15).' },
  { id: 'arrangement', model: M.smart, own: ['src/editor/arrangement/'],
    sections: 'SS18-M1, SS9, SS10 (clip model)',
    brief: 'Arrangement lanes as a kit skin: one row per track; clip create/move/trim/split/loop as FSM verbs, each drag = ghost preview + exactly one command; clip loop brace editing; time ruler formatting bar.beat.tick via the TempoMap (SS8); double-click clip opens the piano roll on it. FSM unit tests with synthetic pointer sequences.' },
  { id: 'app-shell-m1', model: M.code, own: ['src/app/'],
    sections: 'SS18-M1, SS15 (React chrome only), SS3',
    brief: 'React chrome wiring the milestone together: arrangement view hosting canvas editors as opaque components with an imperative bridge; piano roll panel; transport bar (play/stop from M0); global undo/redo (Cmd/Ctrl+Z / Shift+Z) through the command bus; save/load/export-import UI hitting the persistence package. No editor logic in React.' },
];
const ALL_PKGS = WAVE1.concat(WAVE2);

// ---- prompt builders -------------------------------------------------------
const SECTION_NOTE = 'Notation: "SSn" below means section n (the sign used as section marker) of ' + PLAN + '.';

function implPrompt(pkg, ownedPaths, contracts, siblingIds, retryNote) {
  return [
    'Implement work package "' + pkg.id + '" for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton browser DAW. Repo: ' + ROOT + ' (M0 spine already in the tree — build on it, do not rewrite it).',
    SECTION_NOTE,
    '',
    'SPEC: Read ' + PLAN + ' — at minimum ' + pkg.sections + ' — before writing code. In your summary, cite each PLAN section you implemented (fill planSectionsCited).',
    '',
    'SCOPE: ' + pkg.brief,
    '',
    'SHARED CONTRACTS: conform to the frozen interface files: ' + ((contracts.interfaceFiles || []).join(', ') || '(none listed)') + '. Do NOT modify them. If a contract is wrong or missing, implement against it anyway and flag the problem in your summary. Contract author notes: ' + (contracts.notes || '(none)'),
    '',
    'FILE OWNERSHIP (STRICT — other agents are writing in parallel): create/edit files ONLY under: ' + ownedPaths.join(', ') + '. Read anything you like. Do not touch shared config or files owned by other packages; the integration agent wires packages together afterwards.',
    'Do not import from sibling packages being written concurrently in this wave (' + siblingIds.filter((s) => s !== pkg.id).join(', ') + '); import only from the contract files and from code already on disk when you start.',
    '',
    'QUALITY: TypeScript strict must stay clean for your files. Write headless Vitest unit tests for the load-bearing logic (no browser), per PLAN SS15.',
    '',
    'SELF-VERIFY before returning: run `npx tsc --noEmit` and `npx vitest run` from ' + ROOT + ' and report honest results in the schema fields. If failures are outside your package, note that in summary rather than fixing them.',
    retryNote || '',
  ].filter(Boolean).join('\n');
}

function reviewPrompt(lens, round) {
  return [
    'ADVERSARIAL REVIEW — milestone ' + MILESTONE + ' ("' + TITLE + '"), round ' + round + ', lens: ' + lens.id + '.',
    'Your job is to REFUTE the claim that this milestone is correctly and completely implemented, strictly through this lens:',
    lens.charter,
    SECTION_NOTE,
    'Ground truth: ' + PLAN + ' (' + lens.sections + '). Inspect the code and tests under ' + ROOT + '; run `npx tsc --noEmit`, `npx vitest run`, or small targeted scripts if that helps you substantiate a defect. Do NOT fix anything and do NOT write project files (throwaway probe scripts in the scratchpad are fine).',
    'Report ONLY defects you can substantiate (file + concrete explanation; name the violated PLAN section in planSection). Severity: blocker = milestone acceptance fails; major = spec violation or real bug; minor = polish. Return verdict "clean" only if you actively hunted through this lens and found nothing at blocker/major level.',
  ].join('\n');
}

function fixPrompt(findings, round) {
  return [
    'You are the FIX agent for adversarial review round ' + round + ' of milestone ' + MILESTONE + '. You are the only agent writing right now — you may edit any file in ' + ROOT + '.',
    SECTION_NOTE,
    'Findings to address (JSON; independent reviewers, so entries may overlap or conflict — deduplicate and resolve conflicts yourself):',
    JSON.stringify(findings, null, 2),
    'Rules: fix every finding or reject it with a concrete reason (fill rejected[]). Keep changes minimal and in the spirit of ' + PLAN + ' — cite sections when a fix is spec-relevant. Frozen contract interfaces may change only if a blocker requires it; then update every call site and say so in fixed[].',
    'SELF-VERIFY before returning: `npx tsc --noEmit` and `npx vitest run` from ' + ROOT + '; report honest results.',
  ].join('\n');
}

function polishPrompt(minors) {
  return [
    'POLISH pass for milestone ' + MILESTONE + ': apply these MINOR findings only (formatting, naming, comments, small cleanups). Do not change behavior or public interfaces.',
    JSON.stringify(minors, null, 2),
    'Verify with `npx tsc --noEmit` and `npx vitest run` from ' + ROOT + ' before returning.',
  ].join('\n');
}

function criticPrompt(recheck) {
  return [
    'COMPLETENESS CRITIC for milestone ' + MILESTONE + ' ("' + TITLE + '")' + (recheck ? ' — RE-CHECK after gap fixes: report only what is STILL missing.' : '.'),
    SECTION_NOTE,
    'Read ' + PLAN + ' (' + CRITIC_SECTIONS + '), then sweep the code and tests in ' + ROOT + '.',
    'Answer one question exhaustively: what in this milestone\'s spec scope is unimplemented, stubbed, TODO-ed, silently simplified, or untested? Every row of the SS10 FSM table and keyboard map counts individually. Include acceptance-relevant behavior that exists but has no test.',
    'Do NOT fix anything. Severity: blocker = the milestone cannot pass its acceptance gate; major = in-scope spec item missing or untested; minor = polish.',
  ].join('\n');
}

const BROWSER_CHECKS = {
  render: [
    'Arrangement view and piano roll both render; screenshot each at two zoom levels.',
    'Canvases are sized for devicePixelRatio: assert canvas.width === cssWidth * dpr (SS9) and that grid lines are not blurry.',
    'The playhead is a DOM element moved via transform (SS9): assert the element exists and its transform changes during playback while the content canvas is NOT redrawn every frame.',
  ],
  interaction: [
    'Create a clip and notes; drag a note body -> moves by the snapped delta; drag a left/right edge -> resizes with the ANCHORED edge fixed (SS10); Alt+drag -> duplicates.',
    'Marquee-drag on empty grid selects exactly the intersecting notes.',
    'Esc mid-drag reverts the gesture and adds NO undo entry (SS9/SS10).',
    'One gesture == exactly one undo entry: perform a drag, then Ctrl/Cmd+Z restores the prior state exactly, redo reapplies (SS13).',
    'Keyboard map (SS10): arrows transpose/move, Shift+arrows octave/fine, Cmd/Ctrl+D duplicate, Delete, Cmd/Ctrl+U quantize.',
    'Ctrl/Cmd+wheel zoom keeps the tick under the cursor fixed (SS9 zoomAt) -- measure it, do not eyeball it.',
    'Save, reload the page, and confirm the project restores from OPFS unchanged (SS13 autosave; SS2 open->edit->save->reopen stability).',
  ],
};
// Playwright + chromium are ALREADY INSTALLED on this machine (global npm package
// + browser binaries in the default cache). Probes must never re-download them.
function browserPrompt(probe) {
  return [
    'BROWSER VERIFICATION probe "' + probe.id + '" for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton web DAW. Repo: ' + ROOT + '.',
    SECTION_NOTE,
    'Playwright and the chromium browser binaries are ALREADY INSTALLED on this machine — do NOT run `npx playwright install` and do NOT re-download browsers.',
    'VERIFIED ENVIRONMENT (already smoke-tested on this machine — rely on it, do not re-litigate it): OfflineAudioContext renders real samples headlessly (a 440Hz sine gives RMS ~0.5); a live AudioContext reaches state \'running\' with --autoplay-policy=no-user-gesture-required; AudioWorkletNode exists; serving with COOP: same-origin + COEP: require-corp makes crossOriginIsolated true and SharedArrayBuffer available; browser contexts created with deviceScaleFactor: 2 report devicePixelRatio 2, which is how you test DPR-correct canvas sizing.',
    'Install @playwright/test into the project (`npm i -D @playwright/test`) if package.json lacks it — the browser binaries are already in the cache, so this is fast and needs no download.',
    'STATE OF THE SUITE ON DISK (facts, not conclusions — verify them): e2e/ already holds a spec suite from an earlier run of this milestone, and as of commit 269cc44 `npx playwright test` reports 36 passed / 1 skipped / 0 failed. The 1 skip is a deliberate `test.fixme` in e2e/interaction/param-control.spec.ts waiting on M2. RUN THE EXISTING SUITE FIRST and report what you actually observe. You may extend or repair specs in your owned paths, but do not delete or rewrite existing coverage without saying why in a finding — four app defects and three probe defects were just fixed against these specs, and the probe helpers (e2e/interaction/editing-helpers.ts) encode two non-obvious facts: canvas layers are inset from their panel container (the arrangement by 132/26), and theme.velocityStalk is the same color as theme.noteFill on the same layer. Your job is the CHECKS BELOW, whatever the existing suite does or does not cover.',
    'HARNESS: playwright.config.ts and the e2e/ tree were created during M0 scaffold. If playwright.config.ts is missing or broken, ' + (probe.id === 'render' ? 'YOU (and only the render probe) may create/repair it, and must also report the gap as a finding.' : 'do NOT create it — report a blocker finding and work with what exists.'),
    'FILE OWNERSHIP (STRICT — the other probe runs concurrently): write ONLY under ' + probe.own + (probe.id === 'render' ? ' (plus playwright.config.ts if it is absent)' : '') + ', and save screenshots under .playwright/screenshots/' + MILESTONE + '/' + probe.id + '/. Never edit anything under src/ — you are a VERIFIER, not a fixer; defects go in findings[].',
    'SERVE THE APP: run against a PRODUCTION build preview (`npx vite build` then `npx vite preview`), because that is what proves worklet/worker bundling really works. Use the dev server additionally only if a check needs it. Launch chromium with --autoplay-policy=no-user-gesture-required so audio can start headlessly; still exercise the real unlock gesture where the app requires one.',
    'AUDIO IS VERIFIABLE HEADLESSLY: there is no sound card, so never conclude "cannot verify audio". Use page.evaluate to tap the running graph with an AnalyserNode and read RMS, or render the same document through an OfflineAudioContext inside the page and assert on the resulting samples.',
    'RUN THESE CHECKS — every one of them, and report a per-check pass/fail/blocked result:',
    ...probe.checks.map(function (c, i) { return '  ' + (i + 1) + '. ' + c; }),
    'Collect console errors, unhandled rejections and failed network requests across every flow; any of them is at least a major finding.',
    'A check that "passes" against a blank or unmounted page is a FAIL — assert on real content, and eyeball your own screenshots before reporting pass.',
    'Leave the specs on disk and runnable via `npx playwright test` (wire an npm script if none exists and it is within your owned paths).',
    'Report honestly: ran=false only if you were genuinely blocked, and then say why in summary. Findings must name a real file and a concrete defect, with the violated PLAN section in planSection.',
  ].join('\n');
}

const GATE_CHECKLIST = [
  'Toolchain health from ' + ROOT + ': `npx tsc --noEmit` clean, `npx vitest run` green, `npx vite build` succeeds.',
  'Canvas editor kit per SS9: Viewport transform with zoomAt keeping the time under the cursor fixed; four layers with the overlay as the ONLY layer redrawing during a gesture; DOM playhead via transform; binary-search culling; devicePixelRatio rendering.',
  'Arrangement lanes: clip create/move/trim/split/loop all work as ghost-previewed drags committing exactly one command each (SS18-M1).',
  'Piano roll per SS10 IN FULL: hit zones incl. min(6px,40%) edges and velocity stalks; every FSM table row incl. Esc semantics; every keyboard-map row driving the same commands as the mouse; snapping (relative moves preserving off-grid offsets, absolute snap on create only, Alt bypass, resize snaps moving edge only, triplet toggle).',
  'Undo everywhere per SS13: one gesture = one undo entry (verify for a drag, a keyboard nudge, and a clip edit); Esc mid-drag reverts with zero document traffic; inverse patches restore exact prior state; marquee selection is NOT undoable; selection/viewport never enter history.',
  'Persistence per SS13: schemaVersion in saved JSON; OPFS autosave debounced ~2s; export/import .json; open->edit->save->reopen byte-stable except the edits (run the round-trip test).',
  'The kit FSM and piano-roll FSM have headless unit tests fed by synthetic pointer-event sequences (SS15).',
  'Browser evidence (Playwright and chromium are preinstalled — do not reinstall): re-run `npx playwright test` yourself from ' + ROOT + ' against a PRODUCTION build preview and confirm it is green. Then OPEN the screenshots under .playwright/screenshots/' + MILESTONE + '/ and confirm they show the real UI rendered — a green test over a blank or unmounted page is a FAIL, not a pass.',
  'Zero console errors, unhandled rejections, or failed asset requests during the e2e flows; audio behavior verified numerically in-page (AnalyserNode RMS or an OfflineAudioContext render), never assumed.',
];

function gatePrompt(openItems, attempt) {
  return [
    'FINAL ACCEPTANCE GATE for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton DAW — attempt ' + attempt + '. You are a VERIFIER, not a fixer: do not modify any project file.',
    'You are INDEPENDENT of everyone who built this milestone and carry no prior context on it: verify from the artifacts alone, and treat every prior agent\'s self-reported result (tests green, criterion met, file written) as an UNVERIFIED CLAIM until you re-run or re-read it yourself.',
    SECTION_NOTE,
    'Ground truth: ' + PLAN + ' (milestone scope SS18-M1; detail sections ' + CRITIC_SECTIONS + ').',
    'Verify every criterion below by running the commands and inspecting code/tests/behavior:',
    ...GATE_CHECKLIST.map((c, i) => '  ' + (i + 1) + '. ' + c),
    openItems ? 'Open items reported by the completeness critic (check whether resolved): ' + openItems : '',
    'Verdict: pass=true ONLY if every criterion is verifiably met. blockers[]: concrete and actionable (file + what is wrong + which criterion). evidence: what you ran and observed per criterion, briefly.',
  ].filter(Boolean).join('\n');
}

// ---- ownership grant validation -------------------------------------------
function pathsOverlap(a, b) { return a === b || a.startsWith(b) || b.startsWith(a); }
function grantOwnership(pkgs, extra) {
  const granted = {};
  const taken = [];
  for (const p of pkgs) for (const path of p.own) taken.push({ pkg: p.id, path });
  for (const p of pkgs) {
    granted[p.id] = [...p.own];
    for (const path of (extra && extra[p.id]) || []) {
      const clash = taken.find((t) => t.pkg !== p.id && pathsOverlap(t.path, path));
      if (clash) { log('Ownership grant dropped: "' + path + '" for ' + p.id + ' overlaps ' + clash.pkg + '\'s "' + clash.path + '".'); continue; }
      granted[p.id].push(path);
      taken.push({ pkg: p.id, path });
    }
  }
  const unknownPkgs = extra ? Object.keys(extra).filter((k) => !pkgs.some((p) => p.id === k)) : [];
  if (unknownPkgs.length) log('Contracts agent granted ownership to unknown package ids (ignored): ' + unknownPkgs.join(', '));
  return granted;
}

// ---- review lenses ---------------------------------------------------------
const LENSES = [
  { id: 'spec-conformance', sections: 'SS9, SS10, SS13, SS18-M1',
    charter: 'Check EVERY table row of SS10 (hit zones incl. min(6px,40%) edges; the complete FSM table; the complete keyboard map; snapping rules incl. relative moves, Alt bypass, resize-snaps-moving-edge-only, absolute snap on create only) and every SS9 requirement (Viewport transform, four layers, zoom-to-cursor, wheel bindings) is actually implemented, not approximated.' },
  { id: 'gesture-fsm', sections: 'SS9, SS10',
    charter: 'Attack the FSMs with synthetic pointer sequences: Pending promotion at the 3px threshold; Esc mid-drag reverts with ZERO document traffic; exactly one command per completed drag; Alt+body duplicates; marquee selection commits without an undo entry; double-click empty creates a grid-length note; pointer capture holds across leave/enter.' },
  { id: 'performance-60fps', sections: 'SS2, SS9',
    charter: 'Verify the 60fps/2000-note discipline structurally: overlay is the only layer redrawing during a gesture; dirty flags gate grid/content redraws; content culling uses binary search over start-tick-sorted notes; playhead is a DOM transform, never a canvas repaint; no per-frame allocation storms in render loops.' },
  { id: 'undo-integrity', sections: 'SS13, SS3',
    charter: 'Verify one gesture = one undo entry for every mouse AND keyboard verb; inverse patches actually invert (round-trip); redo works after undo chains; selection/viewport/meters never enter the document or history; commands are the only structural write path.' },
  { id: 'persistence-roundtrip', sections: 'SS13, SS2',
    charter: 'Verify schemaVersion presence, ~2s debounced OPFS autosave, .json export/import, and open->edit->save->reopen byte-stability except for edits. Flag any missing round-trip test as major (do not write it yourself).' },
  { id: 'test-strategy', sections: 'SS15 (testing)',
    charter: 'FSMs must be unit-tested by feeding synthetic pointer-event sequences per SS15; command/undo round-trips tested; Viewport math tested. Flag untested load-bearing logic as major. Do not write tests yourself — report the gap.' },
];

// ============================ EXECUTION ====================================
const seedFindings = [];

// ---- Phase: Browser verification (sonnet + Playwright; seeds the review loop)
phase(PH.browser);
const BROWSER_PROBES = [
  { id: 'render', own: 'e2e/render/', checks: BROWSER_CHECKS.render },
  { id: 'interaction', own: 'e2e/interaction/', checks: BROWSER_CHECKS.interaction },
];
const browserResults = (await pipeline(
  BROWSER_PROBES,
  function (probe) {
    return agent(browserPrompt(probe), {
      model: M.code, effort: 'medium', label: 'browser:' + probe.id,
      phase: PH.browser, schema: BROWSER_SCHEMA,
    });
  },
)).filter(Boolean);

let browserEvidence = [];
for (let i = 0; i < BROWSER_PROBES.length; i += 1) {
  const probe = BROWSER_PROBES[i];
  const res = browserResults.find(function (r) { return r && r.probe && r.probe.indexOf(probe.id) !== -1; }) || browserResults[i];
  if (!res || !res.ran) {
    log('Browser probe "' + probe.id + '" did not run; seeding a major finding so the review loop picks it up.');
    seedFindings.push({ severity: 'major', file: probe.own, description: 'browser probe "' + probe.id + '" did not run: ' + (res && res.summary ? res.summary : 'no result returned'), planSection: 'SS15', lens: 'browser-' + probe.id });
    continue;
  }
  const failed = (res.checks || []).filter(function (c) { return c.result !== 'pass'; });
  log('Browser probe "' + probe.id + '": ' + ((res.checks || []).length - failed.length) + '/' + ((res.checks || []).length) + ' checks pass, ' + (res.consoleErrors || []).length + ' console error(s), ' + (res.findings || []).length + ' finding(s).');
  browserEvidence.push({ probe: probe.id, checks: res.checks || [], consoleErrors: res.consoleErrors || [], screenshots: res.screenshots || [] });
  for (const f of (res.findings || [])) seedFindings.push({ ...f, lens: f.lens || ('browser-' + probe.id) });
  for (const ce of (res.consoleErrors || [])) {
    seedFindings.push({ severity: 'major', file: '(browser console)', description: 'console error during ' + probe.id + ' e2e flow: ' + ce, planSection: 'SS15', lens: 'browser-' + probe.id });
  }
}
if (seedFindings.length) log('Seeded ' + seedFindings.length + ' finding(s) into adversarial review round 1 (integration + browser evidence).');

// ---- Phase: Adversarial review (budget-aware loop-until-dry) ---------------
phase(PH.review);
async function adversarialReview() {
  let round = 0;
  let clean = 0;
  let carry = seedFindings.slice();
  let dirtyLenses = new Set();
  while (clean < CLEAN_NEEDED && round < REVIEW_ROUNDS) {
    if (round > 0 && !budgetAllows()) {
      log(MILESTONE + ': stopping adversarial loop before round ' + (round + 1) + ' — budget reserve reached (remaining ' + budget.remaining() + ').');
      break;
    }
    round += 1;
    const lensSet = (round === 1 || dirtyLenses.size === 0)
      ? LENSES
      : LENSES.filter((l) => dirtyLenses.has(l.id) || l.id === 'spec-conformance');
    if (lensSet.length < LENSES.length) log(MILESTONE + ' review round ' + round + ': narrowed to lenses ' + lensSet.map((l) => l.id).join(', ') + ' (others were clean last round).');
    const results = await pipeline(lensSet, (lens) => agent(
      reviewPrompt(lens, round),
      { model: M.smart, effort: 'high', label: 'review:' + lens.id + ':r' + round, phase: PH.review, schema: REVIEW_SCHEMA },
    ));
    const ok = results.filter(Boolean);
    const reviewerFailures = lensSet.length - ok.length;
    if (reviewerFailures > 0) log(MILESTONE + ' review round ' + round + ': ' + reviewerFailures + ' reviewer(s) returned nothing — round cannot count as clean.');
    const findings = ok.flatMap((r) => r.findings.map((f) => ({ ...f, lens: f.lens || r.lens }))).concat(carry);
    carry = [];
    const actionable = findings.filter((f) => f.severity !== 'minor');
    const minors = findings.filter((f) => f.severity === 'minor');
    dirtyLenses = new Set(actionable.map((f) => f.lens || 'spec-conformance'));
    if (actionable.length === 0 && reviewerFailures === 0) {
      clean += 1;
      log(MILESTONE + ' review round ' + round + ': CLEAN (' + clean + '/' + CLEAN_NEEDED + ' consecutive).' + (minors.length ? ' ' + minors.length + ' minor finding(s) -> sonnet polish pass.' : ''));
      if (minors.length) {
        const cappedMinors = minors.slice(0, MAX_FIX);
        if (cappedMinors.length < minors.length) log('Dropped ' + (minors.length - cappedMinors.length) + ' minor findings beyond the per-fix cap.');
        await agent(polishPrompt(cappedMinors), { model: M.code, effort: 'low', label: 'polish:r' + round, phase: PH.review, schema: FIX_SCHEMA });
      }
    } else {
      clean = 0;
      const ordered = actionable.concat(minors);
      const capped = ordered.slice(0, MAX_FIX);
      if (capped.length < ordered.length) log(MILESTONE + ' review round ' + round + ': capped findings for the fixer at ' + MAX_FIX + ' (dropped ' + (ordered.length - capped.length) + '; real ones will resurface next round).');
      log(MILESTONE + ' review round ' + round + ': ' + actionable.length + ' actionable finding(s) across lenses [' + [...dirtyLenses].join(', ') + '] — dispatching one opus fixer.');
      const fix = await agent(fixPrompt(capped, round), { model: M.smart, effort: 'high', label: 'fix:r' + round, phase: PH.review, schema: FIX_SCHEMA });
      if (!fix) { log(MILESTONE + ' review round ' + round + ': fixer returned nothing; findings carry into the next round.'); carry = capped; }
    }
  }
  const converged = clean >= CLEAN_NEEDED;
  if (!converged) log(MILESTONE + ': adversarial loop ended UNCONVERGED after ' + round + ' round(s) (cap ' + REVIEW_ROUNDS + ', cleanRoundsRequired ' + CLEAN_NEEDED + ').');
  return { rounds: round, converged };
}
const reviewOutcome = await adversarialReview();

// ---- Phase: Completeness critic (opus) -------------------------------------
phase(PH.critic);
let critic = await agent(criticPrompt(false), { model: M.smart, effort: 'high', label: 'completeness-critic', phase: PH.critic, schema: CRITIC_SCHEMA });
if (!critic) log('Completeness critic returned nothing; proceeding to gate without a completeness pass.');
let openGaps = critic ? critic.gaps.filter((g) => g.severity !== 'minor') : [];
if (critic && critic.gaps.length > openGaps.length) log('Critic minor gaps (not blocking, left to the gate\'s judgment): ' + (critic.gaps.length - openGaps.length));
if (openGaps.length && budgetAllows()) {
  const capped = openGaps.slice(0, MAX_FIX);
  if (capped.length < openGaps.length) log('Capped critic gaps handed to the gap-fixer at ' + MAX_FIX + ' (dropped ' + (openGaps.length - capped.length) + ').');
  log(MILESTONE + ' critic found ' + openGaps.length + ' gap(s); dispatching opus gap-fixer, then re-checking.');
  await agent(
    'GAP-FIX for milestone ' + MILESTONE + '. The completeness critic found these unimplemented/stubbed/untested items (JSON):\n' + JSON.stringify(capped, null, 2) + '\n' + SECTION_NOTE + '\nImplement or test each one per ' + PLAN + ' (cite sections), or reject with a concrete reason. You are the only writer. SELF-VERIFY: `npx tsc --noEmit` and `npx vitest run` from ' + ROOT + '.',
    { model: M.smart, effort: 'high', label: 'gap-fix', phase: PH.critic, schema: FIX_SCHEMA },
  );
  if (budgetAllows()) {
    const recheck = await agent(criticPrompt(true), { model: M.smart, effort: 'high', label: 'completeness-recheck', phase: PH.critic, schema: CRITIC_SCHEMA });
    if (recheck) openGaps = recheck.gaps.filter((g) => g.severity !== 'minor');
    else log('Critic re-check returned nothing; passing the original gap list to the gate.');
  } else {
    log('Budget reserve reached; skipping critic re-check.');
  }
} else if (openGaps.length) {
  log('Critic found ' + openGaps.length + ' gap(s) but budget reserve reached; passing them to the gate as open items.');
}

// ---- Phase: Acceptance gate (fresh opus verifier; opus fixes blockers between tries)
phase(PH.gate);
let gate = null;
let attempts = 0;
while (true) {
  attempts += 1;
  gate = await agent(
    gatePrompt(openGaps.length ? JSON.stringify(openGaps) : '', attempts),
    { model: M.gate, effort: 'xhigh', label: 'acceptance-gate:attempt' + attempts, phase: PH.gate, schema: GATE_SCHEMA },
  );
  if (!gate) { log('Acceptance gate returned no structured verdict.'); gate = { pass: false, blockers: ['gate agent failed to return a verdict'], evidence: '' }; }
  if (gate.pass) break;
  if (attempts > GATE_RETRIES) { log(MILESTONE + ' gate: out of retries (' + GATE_RETRIES + ').'); break; }
  if (!budgetAllows()) { log(MILESTONE + ' gate failed but budget reserve reached; not attempting a fix cycle.'); break; }
  log(MILESTONE + ' gate attempt ' + attempts + ' FAILED: ' + gate.blockers.join(' | ') + ' — dispatching opus blocker-fix, then re-gating.');
  await agent(
    'BLOCKER-FIX for milestone ' + MILESTONE + '. The acceptance gate failed with these blockers:\n' + JSON.stringify(gate.blockers, null, 2) + '\n' + SECTION_NOTE + '\nFix each one per ' + PLAN + ' (cite sections). You are the only writer. SELF-VERIFY: `npx tsc --noEmit`, `npx vitest run`, `npx vite build` from ' + ROOT + '.',
    { model: M.smart, effort: 'high', label: 'gate-blocker-fix:' + attempts, phase: PH.gate, schema: FIX_SCHEMA },
  );
  openGaps = [];
}

// ---- Phase: Checkpoint -----------------------------------------------------
phase(PH.checkpoint);
if (gate.pass && COMMIT_ON_PASS) {
  await agent(
    'Create a git checkpoint for milestone ' + MILESTONE + ' in ' + ROOT + ': run `git add -A` then `git commit -m "' + MILESTONE + ': ' + TITLE + ' (workflow checkpoint)"`. Do NOT push. Report the commit hash. If there is nothing to commit, say so.',
    { model: M.code, effort: 'low', label: 'checkpoint', phase: PH.checkpoint },
  );
} else {
  log(gate.pass ? 'commitOnPass=false: skipping checkpoint commit.' : 'Gate failed: no checkpoint commit.');
}

log(MILESTONE + ' verdict: ' + (gate.pass ? 'PASS' : 'FAIL') + ' after ' + attempts + ' gate attempt(s); review rounds used: ' + reviewOutcome.rounds + (reviewOutcome.converged ? ' (converged clean)' : ' (NOT converged)'));
return {
  milestone: MILESTONE,
  title: TITLE,
  pass: gate.pass,
  blockers: gate.blockers,
  evidence: gate.evidence,
  reviewRoundsUsed: reviewOutcome.rounds,
  convergedClean: reviewOutcome.converged,
  gateAttempts: attempts,
};
