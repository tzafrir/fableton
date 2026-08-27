/*
 * m4-library.workflow.js — Milestone M4 "Library & finish" (docs/PLAN.md §18-M4).
 * 6 core devices via the §14 playbook (compressor w/ sidechain, EQ, stereo delay,
 * reverb, saturator, second instrument), presets, WAV export via
 * OfflineAudioContext + worker encoder, project-format hardening/migrations.
 * M4's success metric — how LITTLE of M0-M3 it touches — is encoded as the
 * dedicated 'touch-metric' review lens diffing against a recorded git baseline.
 *
 * MODEL POLICY: sonnet = mechanical implementation (each device is
 * template-following per §14 — that is the milestone's acceptance thesis —
 * plus presets plumbing and polish); opus = cross-cutting work (WAV export
 * reusing the engine on OfflineAudioContext, migration hardening), contracts,
 * integration, per-device spot reviews, and ALL adversarial review + fix
 * iterations; a FRESH opus verifier = final acceptance gate ONLY, after the opus loop converges.
 * See const M — used on every agent() call.
 *
 * Browser verification: a Playwright phase (sonnet) runs after integration and
 * seeds its findings into adversarial review round 1; the gate re-runs it.
 *
 * Run standalone:
 *   Workflow({ scriptPath: '/workspaces/fableton/.claude/workflows/m4-library.workflow.js',
 *              args: { reviewRounds: 3 } })
 * Resume:  Workflow({ scriptPath: <same>, resumeFromRunId: '<runId>' })
 * Normally invoked by daw-build.workflow.js via workflow(); this script must
 * NEVER call workflow() itself. Assumes M0-M3 are in the tree (ideally as
 * checkpoint commits, so the touch-metric baseline is meaningful).
 *
 * Args: reviewRounds (3), cleanRoundsRequired (1), gateRetries (1),
 *       budgetReserve (0), commitOnPass (true), maxFindingsPerFix (30).
 * Returns: { milestone, pass, blockers, evidence, reviewRoundsUsed,
 *            convergedClean, gateAttempts }
 */

export const meta = {
  name: 'daw-m4-library',
  description: 'M4 Library & finish: six core devices via the SS14 playbook, presets, WAV export, project-format hardening. Success metric: minimal touching of M0-M3. Ends in an independent opus acceptance gate.',
  phases: [
    { title: 'Contracts', model: 'opus' },
    { title: 'Device pipeline' },
    { title: 'Implement: export & hardening' },
    { title: 'Integration', model: 'opus' },
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

const MILESTONE = 'M4';
const TITLE = 'Library & finish';
const ROOT = '/workspaces/fableton';
const PLAN = ROOT + '/docs/PLAN.md';
const CRITIC_SECTIONS = 'SS7 (versioning/swap), SS12 (Export), SS13 (persistence), SS14, SS15 (testing), SS18-M4';

const A = args || {};
const REVIEW_ROUNDS = A.reviewRounds ?? 3;
const CLEAN_NEEDED = A.cleanRoundsRequired ?? 1;
const GATE_RETRIES = A.gateRetries ?? 1;
const RESERVE = A.budgetReserve ?? 0;
const COMMIT_ON_PASS = A.commitOnPass ?? true;
const MAX_FIX = A.maxFindingsPerFix ?? 30;

const PH = {
  contracts: 'Contracts',
  devices: 'Device pipeline',
  wave2: 'Implement: export & hardening',
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
const DEVICE_REVIEW_SCHEMA = {
  type: 'object', required: ['device', 'verdict', 'findings'],
  properties: { device: { type: 'string' }, verdict: { enum: ['clean', 'defects'] }, findings: { type: 'array', items: FINDING } },
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
  type: 'object', required: ['interfaceFiles', 'notes', 'baseline'],
  properties: {
    interfaceFiles: { type: 'array', items: { type: 'string' } },
    extraOwnership: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
    notes: { type: 'string' },
    baseline: { type: 'string' },
  },
};

// ---- the device roster (each = one sonnet implementer, per the SS14 thesis) -
// File-ownership convention (stated in every prompt, disjoint by short name):
//   src/devices/core/<short>.ts, src/devices/core/__tests__/<short>.test.ts,
//   src/worklets/<short>.worklet.ts (only if custom DSP is required).
// NOBODY edits the shared device-registry index — integration registers all.
const DEVICES = [
  { short: 'compressor', id: 'core.compressor', label: 'Compressor',
    notes: 'Dynamics compressor with threshold/ratio/attack/release/makeup/mix. MUST declare audioIn [{id:"in"},{id:"sc",label:"Sidechain",optional:true}] so it is a sidechain target in the routing UI (SS6/SS14). Keying: when the sc port is connected, the detector follows the sidechain signal — a DynamicsCompressorNode cannot do external keying, so use a small worklet or gain-follower graph for the detector.' },
  { short: 'eq', id: 'core.eq', label: 'EQ',
    notes: '3-4 band EQ from BiquadFilterNodes in series (low shelf / 1-2 peaking / high shelf); per-band freq (log taper Hz), gain (dB), Q; band enable toggles.' },
  { short: 'stereo-delay', id: 'core.stereo-delay', label: 'Stereo Delay',
    notes: 'Implement the SS14 worked example EXACTLY as written (timeL/timeR ms log taper, feedback %, mix % equal-power) — it is the acceptance example for the playbook; ms->s scaling on the delayTime binding.' },
  { short: 'reverb', id: 'core.reverb', label: 'Reverb',
    notes: 'ConvolverNode with a procedurally generated impulse response (noise burst with exponential decay; size/decay params regenerate the IR off-thread or throttled), pre-delay (DelayNode), damping (lowpass in the wet path), mix (equal-power).' },
  { short: 'saturator', id: 'core.saturator', label: 'Saturator',
    notes: 'WaveShaperNode with drive-dependent transfer curve, drive (dB), tone (pre/post filter), mix, oversampling enum (none/2x/4x).' },
  { short: 'chip-synth', id: 'core.chip-synth', label: 'Chip Synth',
    notes: 'Second polyphonic instrument, distinct in character from the M0 synth (e.g. 2-osc subtractive with detune, or simple FM): voice allocator behind noteOn/noteOff/allNotesOff (SS14 "Adding an instrument"), params via p.* factories, worklet or node-per-voice.' },
];

const WAVE2 = [
  { id: 'presets', model: M.code, own: ['src/presets/'],
    sections: 'SS4 (presets are bags of parameter values), SS13 (content-addressed storage), SS18-M4',
    brief: 'Device presets: save the current instance param values (real units) as a named preset; load applies via ParamHandles with SS4 clamping; factory presets per core device (a few each); user presets stored content-addressed (hash -> blob) in OPFS with graceful in-memory fallback for tests; preset picker wired into the device panel header region via existing panel APIs. Round-trip tests.' },
  { id: 'wav-export', model: M.smart, effort: 'high', own: ['src/export/'],
    sections: 'SS12 (Export), SS3 (BaseAudioContext), SS15',
    brief: 'CROSS-CUTTING: WAV export must reuse the SAME engine — instantiate the document on an OfflineAudioContext via the existing reconciler (it already targets BaseAudioContext), run the scheduler in fill-everything mode (no 25ms worker — fill all windows up front or in a tight loop), startRendering(), then encode 16/24-bit PCM WAV in a Web Worker; progress reporting; export dialog entry point. Verify with a headless test: export a small project and assert a valid RIFF/WAVE header, correct byte length for duration/rate/channels, and non-silent samples. Do NOT fork engine code — if the engine resists offline instantiation, report the seam problem in your summary instead of duplicating logic.' },
  { id: 'migrations', model: M.smart, effort: 'high', own: ['src/migrations/', 'src/persist/'],
    sections: 'SS13 (persistence), SS7 (versioning), SS18-M4',
    brief: 'CORRECTNESS-CRITICAL: project-format hardening. Ordered schemaVersion migrations with fixture tests (freeze a copy of the current format as a fixture, write at least one real migration exercising the chain); per-device migrateParams hooks honored on load (SS7: param local-ids are public API); loaded param values clamp to current descriptor ranges (SS4); unknown device ids or param ids fail SOFT — preserved in the document, flagged in the UI, never a crash; corrupted-file handling returns a typed error, not an exception escape. The SS2 byte-stability contract must still hold for current-version files.' },
];

// ---- prompt builders -------------------------------------------------------
const SECTION_NOTE = 'Notation: "SSn" below means section n (the sign used as section marker) of ' + PLAN + '.';

function devImplPrompt(dev) {
  return [
    'Implement the device "' + dev.id + '" (' + dev.label + ') for milestone ' + MILESTONE + ' of the Fableton DAW. Repo: ' + ROOT + ' (M0-M3 complete).',
    SECTION_NOTE,
    'THE THESIS YOU ARE PROVING (SS18-M4): adding a device is ONE definition file via the SS14 playbook, touching nothing else. Read ' + PLAN + ' SS14 and SS7 first and imitate the SS14 StereoDelay example and the existing M0 devices. Cite the sections in your summary.',
    'DEVICE SPEC: ' + dev.notes,
    'FILE OWNERSHIP (STRICT — five other device agents run in parallel): create ONLY src/devices/core/' + dev.short + '.ts, src/devices/core/__tests__/' + dev.short + '.test.ts, and (only if you need custom DSP) src/worklets/' + dev.short + '.worklet.ts. Do NOT edit the shared device-registry index, panels, or any existing file — integration registers all new devices afterwards. If the playbook forces you to touch anything else, STOP and report that as a finding in your summary (it is an architecture defect, not your problem to fix).',
    'REQUIREMENTS: params via the p.* factories with correct real units and tapers (SS4); no raw AudioParam ever leaves the definition; dispose ramps out (SS7); declare ports per SS7 (sc optional input where specified). Include a smoke test: instantiate on an OfflineAudioContext, drive it (notes for instruments, a test tone for effects), render, assert finite non-silent output; effects additionally assert the wet path changes the signal.',
    'SELF-VERIFY before returning: `npx tsc --noEmit` and `npx vitest run` from ' + ROOT + '; report honest results in the schema fields.',
  ].join('\n');
}

function devReviewPrompt(dev, impl) {
  return [
    'PER-DEVICE SPOT REVIEW (adversarial) of "' + dev.id + '" in ' + ROOT + '. Files claimed: ' + (impl.filesWritten || []).join(', ') + '. Implementer summary: ' + impl.summary,
    SECTION_NOTE,
    'Read ' + PLAN + ' SS14, SS7, SS5, SS4, then the device code and its test. Try to REFUTE its correctness:',
    '- Seam integrity: any raw AudioParam/setter leaking past the definition? Params not registered via p.*/descriptors? (SS4 design rule)',
    '- Spec fit: ports declared per SS7 (sc where required)? tapers/units/ranges sane for the DSP? dispose ramps out? instruments: voice stealing + allNotesOff correct?',
    '- Playbook purity: did it touch ANY file beyond its three allowed paths (check git status / file list)? That is a major finding.',
    '- Test quality: does the smoke test actually assert audible behavior, not just "no throw"?',
    '- Device spec: ' + dev.notes,
    'Run the device test in isolation if useful (`npx vitest run src/devices/core/__tests__/' + dev.short + '.test.ts`). Do NOT fix anything. Report only substantiated defects with severities; verdict "clean" only after an honest hunt.',
  ].join('\n');
}

function devFixPrompt(dev, findings) {
  return [
    'PER-DEVICE FIX for "' + dev.id + '" in ' + ROOT + '. Address these spot-review findings (JSON):',
    JSON.stringify(findings, null, 2),
    SECTION_NOTE,
    'Stay inside the device\'s own files (src/devices/core/' + dev.short + '.ts, its test, its worklet) unless a finding explicitly requires otherwise — then explain in fixed[]. Follow ' + PLAN + ' SS14/SS7. Reject a finding only with a concrete reason.',
    'SELF-VERIFY: `npx tsc --noEmit` and `npx vitest run` from ' + ROOT + '; report honestly.',
  ].join('\n');
}

function implPrompt(pkg, ownedPaths, contracts, siblingIds, retryNote) {
  return [
    'Implement work package "' + pkg.id + '" for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton browser DAW. Repo: ' + ROOT + ' (M0-M3 complete — build on them; the milestone metric is touching them as LITTLE as possible).',
    SECTION_NOTE,
    '',
    'SPEC: Read ' + PLAN + ' — at minimum ' + pkg.sections + ' — before writing code. In your summary, cite each PLAN section you implemented (fill planSectionsCited).',
    '',
    'SCOPE: ' + pkg.brief,
    '',
    'SHARED CONTRACTS: conform to the frozen interface files: ' + ((contracts.interfaceFiles || []).join(', ') || '(none listed)') + '. Do NOT modify them. If a contract is wrong or missing, implement against it anyway and flag the problem in your summary. Contract author notes: ' + (contracts.notes || '(none)'),
    '',
    'FILE OWNERSHIP (STRICT — other agents are writing in parallel): create/edit files ONLY under: ' + ownedPaths.join(', ') + '. Read anything you like. Every pre-M4 file you feel forced to modify is evidence against the architecture — flag it in your summary instead wherever possible; the integration agent handles cross-cutting edits.',
    'Do not import from sibling packages being written concurrently in this wave (' + siblingIds.filter((s) => s !== pkg.id).join(', ') + '); import only from the contract files and from code already on disk when you start.',
    '',
    'QUALITY: TypeScript strict must stay clean for your files. Write headless Vitest tests per PLAN SS15.',
    '',
    'SELF-VERIFY before returning: run `npx tsc --noEmit` and `npx vitest run` from ' + ROOT + ' and report honest results in the schema fields. If failures are outside your package, note that in summary rather than fixing them.',
    retryNote || '',
  ].filter(Boolean).join('\n');
}

function reviewPrompt(lens, round, baseline) {
  return [
    'ADVERSARIAL REVIEW — milestone ' + MILESTONE + ' ("' + TITLE + '"), round ' + round + ', lens: ' + lens.id + '.',
    'Your job is to REFUTE the claim that this milestone is correctly and completely implemented, strictly through this lens:',
    lens.charter,
    lens.id === 'touch-metric' ? 'Pre-M4 baseline commit recorded at milestone start: ' + (baseline || '(none recorded — approximate via git log/status and say so in your findings)') : '',
    SECTION_NOTE,
    'Ground truth: ' + PLAN + ' (' + lens.sections + '). Inspect the code and tests under ' + ROOT + '; run `npx tsc --noEmit`, `npx vitest run`, git diffs, or small targeted scripts if that helps you substantiate a defect. Do NOT fix anything and do NOT write project files (throwaway probe scripts in the scratchpad are fine).',
    'Report ONLY defects you can substantiate (file + concrete explanation; name the violated PLAN section in planSection). Severity: blocker = milestone acceptance fails; major = spec violation or real bug; minor = polish. Return verdict "clean" only if you actively hunted through this lens and found nothing at blocker/major level.',
  ].filter(Boolean).join('\n');
}

function fixPrompt(findings, round) {
  return [
    'You are the FIX agent for adversarial review round ' + round + ' of milestone ' + MILESTONE + '. You are the only agent writing right now — you may edit any file in ' + ROOT + '.',
    SECTION_NOTE,
    'Findings to address (JSON; independent reviewers, so entries may overlap or conflict — deduplicate and resolve conflicts yourself):',
    JSON.stringify(findings, null, 2),
    'Rules: fix every finding or reject it with a concrete reason (fill rejected[]). Keep changes minimal and in the spirit of ' + PLAN + ' — the M4 metric is touching pre-M4 code as little as possible, so prefer fixes inside M4 files. Cite sections when a fix is spec-relevant.',
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
    'Answer one question exhaustively: what in this milestone\'s spec scope is unimplemented, stubbed, TODO-ed, silently simplified, or untested? Each of the six devices counts individually (registered? panel renders? automatable? preset-able?); presets, WAV export, and every migration/hardening behavior count. Include acceptance-relevant behavior that exists but has no test.',
    'Do NOT fix anything. Severity: blocker = the milestone cannot pass its acceptance gate; major = in-scope spec item missing or untested; minor = polish.',
  ].join('\n');
}

const BROWSER_CHECKS = {
  render: [
    'Every shipped device panel renders -- screenshot ONE PER DEVICE -- with all params visible, correctly labeled and unit-formatted (SS5 default panel generation / SS14).',
    'Preset save and load round-trip through the UI and the panel reflects the loaded values.',
  ],
  interaction: [
    'Drag each device from the browser panel into a chain (track, group AND master) and confirm it processes audio.',
    'Instrument swap (SS7): clips are untouched, the swap is click-free, params carry over by matching local id, and automation lanes targeting the old instance are KEPT AND GREYED, never deleted.',
    'Compressor sidechain: pick a source channel in \'Audio From\' and verify gain reduction correlates with the source signal.',
    'WAV export: trigger it, capture the download, and assert a valid non-silent WAV of the expected duration and sample rate (SS12 OfflineAudioContext path).',
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
  'Six devices (compressor, EQ, stereo delay, reverb, saturator, chip synth) are registered, insertable into any chain incl. groups and master, get generated or declared panels with correctly-tapered controls, appear in the automation lane menu, and pass their smoke tests (run them).',
  'The compressor declares an optional sc port and is keyable from the "Audio From" picker via a document SidechainEdge — verify the detector actually follows the sidechain signal (test or offline render).',
  'The stereo delay matches the SS14 worked example (params, taper/units, feedback topology, equal-power mix).',
  'Presets: save/load per device as bags of real-unit param values with clamping; factory presets present; content-addressed OPFS storage per SS13.',
  'WAV export per SS12: the SAME reconciler+scheduler instantiated on OfflineAudioContext (grep for forked engine code — a second implementation is a blocker), worker-encoded WAV; run the export test and verify RIFF/WAVE header, byte length, non-silent audio.',
  'Migrations/hardening per SS13/SS7: ordered schemaVersion migrations with fixture tests; per-device migrateParams honored; out-of-range values clamp; unknown device ids fail soft (project still loads); current-version files remain byte-stable over open->save.',
  'THE M4 METRIC (SS18-M4): diff against the recorded pre-M4 baseline commit. Count modified pre-existing files; each must be an expected registration point (device index, app menu/panel wiring, package.json) or convincingly justified. Report the count and the list in evidence; excessive or unjustified touching of M0-M3 code is a blocker — it falsifies the extensibility thesis.',
  'Browser evidence (Playwright and chromium are preinstalled — do not reinstall): re-run `npx playwright test` yourself from ' + ROOT + ' against a PRODUCTION build preview and confirm it is green. Then OPEN the screenshots under .playwright/screenshots/' + MILESTONE + '/ and confirm they show the real UI rendered — a green test over a blank or unmounted page is a FAIL, not a pass.',
  'Zero console errors, unhandled rejections, or failed asset requests during the e2e flows; audio behavior verified numerically in-page (AnalyserNode RMS or an OfflineAudioContext render), never assumed.',
];

function gatePrompt(openItems, attempt, baseline) {
  return [
    'FINAL ACCEPTANCE GATE for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton DAW — attempt ' + attempt + '. You are a VERIFIER, not a fixer: do not modify any project file.',
    'You are INDEPENDENT of everyone who built this milestone and carry no prior context on it: verify from the artifacts alone, and treat every prior agent\'s self-reported result (tests green, criterion met, file written) as an UNVERIFIED CLAIM until you re-run or re-read it yourself.',
    SECTION_NOTE,
    'Ground truth: ' + PLAN + ' (milestone scope SS18-M4; detail sections ' + CRITIC_SECTIONS + ').',
    'Pre-M4 baseline commit for the touch metric: ' + (baseline || '(none recorded — approximate via git history and say so in evidence)'),
    'Verify every criterion below by running the commands and inspecting code/tests/behavior:',
    ...GATE_CHECKLIST.map((c, i) => '  ' + (i + 1) + '. ' + c),
    openItems ? 'Open items reported by the completeness critic (check whether resolved): ' + openItems : '',
    'Verdict: pass=true ONLY if every criterion is verifiably met. blockers[]: concrete and actionable (file + what is wrong + which criterion). evidence: what you ran and observed per criterion, briefly — including the touch-metric file count and list.',
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
  { id: 'spec-conformance', sections: 'SS14, SS7, SS12 (Export), SS13, SS18-M4',
    charter: 'Each device is one definition file using p.* factories with correct real units/tapers; the stereo delay matches the SS14 example; compressor sidechain is a routable sc port; presets are bags of param values; WAV export reuses the engine on OfflineAudioContext with a worker encoder (a parallel render engine is a blocker); migrations follow the SS13/SS7 discipline.' },
  { id: 'touch-metric', sections: 'SS18-M4',
    charter: 'M4 succeeds by how LITTLE of M0-M3 it touches — that is the acceptance thesis. Diff the working tree against the recorded pre-M4 baseline commit; list every modified pre-existing file. Expected registration points (device registry index, app menu/panel wiring, package.json/lockfile) are fine; anything else is a finding — major, or blocker if it rewrites a load-bearing seam.' },
  { id: 'device-quality', sections: 'SS14, SS5, SS7, SS4',
    charter: 'Attack each of the six devices: parameter ranges/tapers audibly sane; no raw AudioParam leaks (SS4 rule); dispose ramps out and disposal after tails; generated panels usable; the sidechain compressor genuinely keys from the edge (not from its own input); instruments handle voice stealing, hanging notes, allNotesOff; worklets are allocation-free per render quantum.' },
  { id: 'migration-hardening', sections: 'SS13, SS7, SS2',
    charter: 'schemaVersion ordered migrations and per-device migrateParams exist and are exercised by fixture tests (an old-format fixture must actually load); out-of-range values clamp per SS4; unknown device/param ids fail soft without data loss; corrupted files produce typed errors; open->save of a current-version file stays byte-stable (SS2).' },
  { id: 'test-strategy', sections: 'SS15 (testing)',
    charter: 'Every device has a smoke test asserting audible behavior on an OfflineAudioContext render (not merely "no throw"); WAV export has a header/length/content test; migrations have fixture tests; presets have round-trip tests. Flag gaps as major; do not write tests yourself.' },
];

// ============================ EXECUTION ====================================
const seedFindings = [];

// ---- Phase: Contracts (opus) + baseline capture ----------------------------
phase(PH.contracts);
let contracts = await agent(
  [
    'You are the INTERFACE AUTHOR for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton DAW. Parallel implementers will code against your output as a FROZEN contract.',
    SECTION_NOTE,
    'FIRST: record the touch-metric baseline. Run `git -C ' + ROOT + ' rev-parse HEAD` and put the hash in the schema field "baseline" (empty string if the repo has no commits — then note that in notes). If the working tree is dirty, note that too.',
    'Read ' + PLAN + ' in full, with special care on ' + CRITIC_SECTIONS + '. Then read the existing M0-M3 code (device harness, p.* factories, panel generation, persistence) — M4 should need almost NO new interfaces; that is the point. Add to ' + ROOT + '/src/types/ ONLY what is genuinely missing: preset format types, export request/progress types, migration function signatures. Interfaces only; must compile under strict tsc.',
    'Also confirm in notes, for the six device implementers: the exact p.* factory import path, the device-registry registration call they must NOT touch, and the panel-generation behavior they get for free.',
    'Non-device packages and their exclusive paths: ' + WAVE2.map((p) => p.id + ' -> ' + p.own.join(' + ')).join('; ') + '. Devices use the fixed per-short-name convention in src/devices/core/ and src/worklets/.',
    'In the schema: interfaceFiles, extraOwnership (for the non-device packages only; must not overlap), notes, baseline.',
    'SELF-VERIFY: `npx tsc --noEmit` from ' + ROOT + ' passes.',
  ].join('\n'),
  { model: M.smart, effort: 'high', label: 'contracts', phase: PH.contracts, schema: CONTRACT_SCHEMA },
);
if (!contracts) {
  log('Contracts agent returned nothing; proceeding with convention-only contracts and NO baseline (touch-metric lens will approximate).');
  contracts = { interfaceFiles: [], extraOwnership: {}, notes: 'Contracts agent failed. Imitate the existing M0 devices and PLAN.md SS14 verbatim.', baseline: '' };
} else {
  log('Contracts frozen. Baseline commit for touch metric: ' + (contracts.baseline || '(none)'));
}
const OWN = grantOwnership(WAVE2, contracts.extraOwnership);

// ---- Phase: Device pipeline (per-item: sonnet implement -> opus spot-review
// -> opus fix-if-dirty; no cross-item barriers — items flow independently) ----
phase(PH.devices);
const devResults = await pipeline(
  DEVICES,
  (dev) => agent(devImplPrompt(dev), { model: M.code, label: 'dev:' + dev.short, phase: PH.devices, schema: IMPL_SCHEMA }),
  async (impl, dev) => {
    if (!impl) return null;
    const review = await agent(devReviewPrompt(dev, impl), { model: M.smart, effort: 'high', label: 'devreview:' + dev.short, phase: PH.devices, schema: DEVICE_REVIEW_SCHEMA });
    if (!review) return { device: dev.id, status: 'review-failed', impl };
    if (review.verdict === 'clean' || review.findings.length === 0) return { device: dev.id, status: 'clean', impl };
    return { device: dev.id, status: 'defects', impl, findings: review.findings };
  },
  async (prev, dev) => {
    if (!prev) return null;
    if (prev.status !== 'defects') return prev;
    const fix = await agent(devFixPrompt(dev, prev.findings), { model: M.smart, effort: 'high', label: 'devfix:' + dev.short, phase: PH.devices, schema: FIX_SCHEMA });
    return { device: dev.id, status: fix ? 'fixed' : 'fix-failed', findings: prev.findings, impl: prev.impl };
  },
);
const devOk = devResults.filter(Boolean);
devResults.forEach((r, i) => {
  const dev = DEVICES[i];
  if (!r) {
    log('Device ' + dev.id + ': pipeline item failed entirely — seeding blocker finding.');
    seedFindings.push({ severity: 'blocker', file: 'src/devices/core/' + dev.short + '.ts', description: 'device ' + dev.id + ' failed to implement (pipeline item returned null)', planSection: 'SS14', lens: 'spec-conformance' });
  } else if (r.status === 'fix-failed' || r.status === 'review-failed') {
    log('Device ' + dev.id + ': ' + r.status + ' — seeding major finding for the milestone review loop.');
    seedFindings.push({ severity: 'major', file: 'src/devices/core/' + dev.short + '.ts', description: 'device ' + dev.id + ' ' + r.status + (r.findings ? '; unresolved spot findings: ' + JSON.stringify(r.findings) : ''), planSection: 'SS14', lens: 'device-quality' });
  }
});
log('Device pipeline: ' + devOk.map((r) => r.device + ':' + r.status).join('  '));

// ---- Phase: wave 2 (presets / wav-export / migrations) ---------------------
phase(PH.wave2);
async function runWave(waveName, phaseTitle, pkgs) {
  const siblings = pkgs.map((p) => p.id);
  const results = await pipeline(pkgs, (pkg) => agent(
    implPrompt(pkg, OWN[pkg.id], contracts, siblings),
    { model: pkg.model, effort: pkg.effort, label: 'impl:' + pkg.id, phase: phaseTitle, schema: IMPL_SCHEMA },
  ));
  const out = [];
  const failed = [];
  results.forEach((r, i) => { if (r) out.push(r); else failed.push(pkgs[i]); });
  if (failed.length) {
    log(MILESTONE + ' ' + waveName + ': packages returned no result: ' + failed.map((p) => p.id).join(', ') + ' — retrying each once.');
    const retries = await pipeline(failed, (pkg) => agent(
      implPrompt(pkg, OWN[pkg.id], contracts, siblings, 'RETRY: a previous attempt may have left partial work in your owned paths — inspect what exists and finish it.'),
      { model: pkg.model, effort: pkg.effort, label: 'impl-retry:' + pkg.id, phase: phaseTitle, schema: IMPL_SCHEMA },
    ));
    retries.forEach((r, i) => {
      if (r) { out.push(r); return; }
      log(MILESTONE + ' ' + waveName + ': ' + failed[i].id + ' failed twice; seeding blocker finding for the review loop.');
      seedFindings.push({ severity: 'blocker', file: OWN[failed[i].id].join(', '), description: 'work package ' + failed[i].id + ' produced no result after retry; owned paths may hold partial or missing work', planSection: failed[i].sections, lens: 'spec-conformance' });
    });
  }
  for (const r of out) {
    if (!r.tscClean || !r.testsPassed) {
      seedFindings.push({ severity: 'major', file: (r.filesWritten || []).join(', '), description: 'package ' + r.pkg + ' self-reported tscClean=' + r.tscClean + ' testsPassed=' + r.testsPassed + ': ' + r.summary, planSection: '', lens: 'spec-conformance' });
    }
  }
  log(MILESTONE + ' ' + waveName + ' done: ' + out.map((r) => r.pkg).join(', '));
  return out;
}
const w2 = await runWave('wave 2', PH.wave2, WAVE2);

// ---- Phase: Integration (opus, single writer) ------------------------------
phase(PH.integration);
const integration = await agent(
  [
    'INTEGRATION agent for milestone ' + MILESTONE + ' ("' + TITLE + '"). All work is on disk. You are the only writer; you may edit any file in ' + ROOT + ' — but the M4 metric is touching pre-M4 files as LITTLE as possible, so keep glue edits to the expected registration points and list every pre-M4 file you modify with a one-line justification.',
    SECTION_NOTE,
    'Device pipeline results: ' + JSON.stringify(devOk.map((r) => ({ device: r.device, status: r.status }))),
    'Package reports: ' + JSON.stringify(w2.map((r) => ({ pkg: r.pkg, files: r.filesWritten, summary: r.summary }))),
    'Wire it together: register all six devices in the device-registry index (the single expected touch point); expose presets in panel headers; add the WAV export entry point to the app menu/transport area; ensure migrations run on project load. Cite PLAN sections for spec-relevant wiring decisions.',
    'MUST end green from ' + ROOT + ': `npx tsc --noEmit`, `npx vitest run`, `npx vite build`. Report honestly; list every file you changed.',
  ].join('\n'),
  { model: M.smart, effort: 'high', label: 'integration', phase: PH.integration, schema: INTEGRATION_SCHEMA },
);
if (!integration || !integration.tscClean || !integration.testsPassed || !integration.buildOk) {
  log('Integration reported problems; seeding blocker finding for the review loop.');
  seedFindings.push({ severity: 'blocker', file: '(integration)', description: 'integration incomplete: ' + (integration ? integration.summary : 'integration agent returned nothing'), planSection: 'SS18-M4', lens: 'spec-conformance' });
}

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
      reviewPrompt(lens, round, contracts.baseline),
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
    'GAP-FIX for milestone ' + MILESTONE + '. The completeness critic found these unimplemented/stubbed/untested items (JSON):\n' + JSON.stringify(capped, null, 2) + '\n' + SECTION_NOTE + '\nImplement or test each one per ' + PLAN + ' (cite sections), or reject with a concrete reason. You are the only writer; prefer edits inside M4 files (the touch metric is live). SELF-VERIFY: `npx tsc --noEmit` and `npx vitest run` from ' + ROOT + '.',
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
    gatePrompt(openGaps.length ? JSON.stringify(openGaps) : '', attempts, contracts.baseline),
    { model: M.gate, effort: 'xhigh', label: 'acceptance-gate:attempt' + attempts, phase: PH.gate, schema: GATE_SCHEMA },
  );
  if (!gate) { log('Acceptance gate returned no structured verdict.'); gate = { pass: false, blockers: ['gate agent failed to return a verdict'], evidence: '' }; }
  if (gate.pass) break;
  if (attempts > GATE_RETRIES) { log(MILESTONE + ' gate: out of retries (' + GATE_RETRIES + ').'); break; }
  if (!budgetAllows()) { log(MILESTONE + ' gate failed but budget reserve reached; not attempting a fix cycle.'); break; }
  log(MILESTONE + ' gate attempt ' + attempts + ' FAILED: ' + gate.blockers.join(' | ') + ' — dispatching opus blocker-fix, then re-gating.');
  await agent(
    'BLOCKER-FIX for milestone ' + MILESTONE + '. The acceptance gate failed with these blockers:\n' + JSON.stringify(gate.blockers, null, 2) + '\n' + SECTION_NOTE + '\nFix each one per ' + PLAN + ' (cite sections); prefer edits inside M4 files (the touch metric is live). You are the only writer. SELF-VERIFY: `npx tsc --noEmit`, `npx vitest run`, `npx vite build` from ' + ROOT + '.',
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
