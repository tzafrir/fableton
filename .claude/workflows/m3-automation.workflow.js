/*
 * m3-automation.workflow.js — Milestone M3 "Automation" (docs/PLAN.md §18-M3).
 * Automation lanes + curve editing on the canvas kit, BOTH playback paths
 * (AudioParam ramps / 200Hz message path), the free->automated->overridden
 * state machine with the transport Re-enable pill, and mixer-param automation.
 *
 * MODEL POLICY: sonnet = mechanical implementation (lane CRUD/doc plumbing,
 * mixer-automation wiring, polish); opus = load-bearing seams (§11 dual playback
 * paths + sampler, §4 override state machine in the registry, §9-based curve
 * editor), contracts, integration, ALL adversarial review + fix iterations;
 * a FRESH opus verifier = final acceptance gate ONLY, after the opus loop converges.
 * See const M — used on every agent() call.
 *
 * Browser verification: a Playwright phase (sonnet) runs after integration and
 * seeds its findings into adversarial review round 1; the gate re-runs it.
 *
 * Run standalone:
 *   Workflow({ scriptPath: '/workspace/fableton/.claude/workflows/m3-automation.workflow.js',
 *              args: { reviewRounds: 3 } })
 * Resume:  Workflow({ scriptPath: <same>, resumeFromRunId: '<runId>' })
 * Normally invoked by daw-build.workflow.js via workflow(); this script must
 * NEVER call workflow() itself. Assumes M0+M1+M2 are in the tree.
 *
 * Args: reviewRounds (3), cleanRoundsRequired (1), gateRetries (1),
 *       budgetReserve (0), commitOnPass (true), maxFindingsPerFix (30).
 * Returns: { milestone, pass, blockers, evidence, reviewRoundsUsed,
 *            convergedClean, gateAttempts }
 */

export const meta = {
  name: 'daw-m3-automation',
  description: 'M3 Automation: lanes + curve editing on the editor kit, dual playback paths, override/re-enable state machine, mixer-param automation. Ends in an independent opus acceptance gate.',
  phases: [
    { title: 'Contracts', model: 'opus' },
    { title: 'Implement: model & sampler' },
    { title: 'Implement: editor & override' },
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

const MILESTONE = 'M3';
const TITLE = 'Automation';
const ROOT = '/workspace/fableton';
const PLAN = ROOT + '/docs/PLAN.md';
const CRITIC_SECTIONS = 'SS3, SS4 (automated/overridden), SS9, SS11, SS12, SS15 (testing), SS18-M3';

const A = args || {};
const REVIEW_ROUNDS = A.reviewRounds ?? 3;
const CLEAN_NEEDED = A.cleanRoundsRequired ?? 1;
const GATE_RETRIES = A.gateRetries ?? 1;
const RESERVE = A.budgetReserve ?? 0;
const COMMIT_ON_PASS = A.commitOnPass ?? true;
const MAX_FIX = A.maxFindingsPerFix ?? 30;

const PH = {
  contracts: 'Contracts',
  wave1: 'Implement: model & sampler',
  wave2: 'Implement: editor & override',
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
  { id: 'automation-model', model: M.code, own: ['src/model/automation/'],
    sections: 'SS11 (data model), SS13, SS4 (registry as lane menu)',
    brief: 'Document model + commands: AutoPoint {t Ticks, v real units, curve -1..1} and AutomationLane {id, paramId, points, enabled} hanging off the owning channel; lane CRUD commands (create/delete/enable/disable, add/move/remove points, bend segments) through the command bus with undo; the lane-creation menu data source as a filtered view of the ParamRegistry; on device swap, lanes targeting old params are kept-greyed-rebindable (SS7) — expose the rebind command. Persistence of lanes in the project JSON. Unit tests for lane commands and serialization.' },
  { id: 'automation-sampler', model: M.smart, effort: 'high', own: ['src/engine/automation/'],
    sections: 'SS11 (Playback — both paths), SS12, SS4',
    brief: 'THE dual-path playback seam. The automation sampler fills each SS12 look-ahead window: AudioParam path = setValueAtTime + linearRampToValueAtTime per segment, bent segments sampled into short setValueCurveAtTime chunks; live edits during playback cancelAndHoldAtTime from the edit point and reschedule the remainder of the window. Message path = sample at 200Hz control rate into timestamped messages; worklet-side interpolation between them; enum/toggle changes applied exactly at segment boundaries. Path chosen per param by its binding (bindAudioParam vs bindMessage, SS4). Curve evaluation (the -1..1 bend function) is a shared pure function, unit-tested; window-fill logic unit-tested against a mock clock; an OfflineAudioContext test renders an automated sweep and asserts the parameter actually moved.' },
];
const WAVE2 = [
  { id: 'override-state', model: M.smart, effort: 'high', own: ['src/params/', 'src/ui/transport/'],
    sections: 'SS4 (Automated/overridden state), SS11 (Interaction with the knob)',
    brief: 'The free->automated->overridden state machine inside the ParamRegistry (it lives in registry UI state, NEVER in the document): an enabled lane puts the param in automated (knob shows the moving live value with base() as a ghost dot — wire the control-kit hooks); touching an automated control during playback flips it to overridden and suspends automation for THAT param only; the transport-level Re-enable Automation pill lights when any param is overridden and restores all on click; deleting a lane frees the param, disabling keeps data inert. State-transition unit tests for every edge.' },
  { id: 'automation-editor', model: M.smart, effort: 'high', own: ['src/editor/automation/'],
    sections: 'SS11 (Editing), SS9, SS5',
    brief: 'Automation lanes as kit editor #3, reusing the canvas kit VERBATIM (Viewport, layers, gesture FSM — no parallel implementations): expandable rows under the track in the arrangement; click a segment to add a point; drag points (snap on the time axis only); drag a segment middle to bend curve; marquee + the same keyboard nudges as the piano roll; vertical axis maps through the param taper (log-taper cutoff sweeps render straight); stepped/enum/toggle params render and edit as steps. Ghost-preview drags, one command per gesture. FSM tests from synthetic pointer sequences.' },
  { id: 'mixer-automation', model: M.code, own: ['src/ui/mixer/'],
    sections: 'SS11 (last paragraph), SS4, SS6',
    brief: 'Prove "automate anything": volume/pan/send params automate exactly like device params — lane creation from the mixer strip context menus, lanes render under the track, both playback paths work for mixer params (volume/pan are AudioParam-bound gains; verify sends too). Mostly wiring + an end-to-end test (offline render with automated volume asserting a fade landed in the buffer).' },
];
const ALL_PKGS = WAVE1.concat(WAVE2);

// ---- prompt builders -------------------------------------------------------
const SECTION_NOTE = 'Notation: "SSn" below means section n (the sign used as section marker) of ' + PLAN + '.';

function implPrompt(pkg, ownedPaths, contracts, siblingIds, retryNote) {
  return [
    'Implement work package "' + pkg.id + '" for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton browser DAW. Repo: ' + ROOT + ' (M0-M2 already in the tree — build on them, do not rewrite them).',
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
    'Answer one question exhaustively: what in this milestone\'s spec scope is unimplemented, stubbed, TODO-ed, silently simplified, or untested? Both playback paths count separately; every override-state transition counts individually; stepped/enum/toggle lane editing counts; mixer-param automation counts. Include acceptance-relevant behavior that exists but has no test.',
    'Do NOT fix anything. Severity: blocker = the milestone cannot pass its acceptance gate; major = in-scope spec item missing or untested; minor = polish.',
  ].join('\n');
}

const BROWSER_CHECKS = {
  render: [
    'An automation lane expands under a track and renders the curve through the param\'s TAPER (SS11: a log-taper cutoff sweep looks straight); stepped/enum/toggle params render as steps. Screenshot each.',
    'An automated knob shows the moving live value in accent with a ghost dot at base() (SS4); an overridden knob renders dim/pulsing; the transport \'Re-enable automation\' pill lights when any param is overridden.',
  ],
  interaction: [
    'Click a segment adds a point; drag a point snaps on the TIME axis only; drag a segment\'s middle bends its curve value (SS11).',
    'During playback an automated param\'s live value tracks the lane -- sample the UI readout at several transport positions and compare against the lane\'s expected value.',
    'Touch an automated knob during playback -> the param flips to \'overridden\' and the pill lights; click the pill -> automation resumes for every overridden param (SS4/SS11).',
    'Exercise BOTH playback paths (SS11): one AudioParam-bound param and one message/worklet-bound param, and confirm they produce equivalent results by comparing in-page OfflineAudioContext renders.',
    'Edit a lane DURING playback and confirm the remainder of the look-ahead window reschedules without a click (SS11 cancelAndHoldAtTime).',
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
  'Data model per SS11: AutoPoint {t,v,curve -1..1} in REAL units; lanes hang off the owning channel, render as expandable rows under the track; enabled flag; lane menu is a filtered view of the ParamRegistry (verify mixer params appear).',
  'Curve editing on the kit per SS11: click-segment adds a point, point drag snaps on the time axis only, segment-middle drag bends curve, marquee + keyboard nudges work, vertical axis maps through the param taper, stepped/enum/toggle render and edit as steps. The editor must reuse the M1 kit (no parallel gesture/render code).',
  'AudioParam playback path: look-ahead windows filled with setValueAtTime/linearRampToValueAtTime, bent segments via setValueCurveAtTime chunks; live edits during playback cancelAndHoldAtTime and reschedule the window remainder. Verify via the OfflineAudioContext sweep test AND code inspection.',
  'Message playback path: 200Hz control-rate timestamped messages with worklet interpolation; enum/toggle changes applied exactly at segment boundaries.',
  'Override state machine per SS4: enabled lane -> automated (knob shows live value + base ghost dot); touching during playback -> overridden (that param only); transport Re-enable pill lights and restores ALL; delete frees, disable keeps data inert; none of this state dirties the document (verify the project JSON is unchanged by override toggling).',
  'Mixer-param automation end-to-end: an automated volume fade renders into an offline buffer (run the test).',
  'Browser evidence (Playwright and chromium are preinstalled — do not reinstall): re-run `npx playwright test` yourself from ' + ROOT + ' against a PRODUCTION build preview and confirm it is green. Then OPEN the screenshots under .playwright/screenshots/' + MILESTONE + '/ and confirm they show the real UI rendered — a green test over a blank or unmounted page is a FAIL, not a pass.',
  'Zero console errors, unhandled rejections, or failed asset requests during the e2e flows; audio behavior verified numerically in-page (AnalyserNode RMS or an OfflineAudioContext render), never assumed.',
];

function gatePrompt(openItems, attempt) {
  return [
    'FINAL ACCEPTANCE GATE for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton DAW — attempt ' + attempt + '. You are a VERIFIER, not a fixer: do not modify any project file.',
    'You are INDEPENDENT of everyone who built this milestone and carry no prior context on it: verify from the artifacts alone, and treat every prior agent\'s self-reported result (tests green, criterion met, file written) as an UNVERIFIED CLAIM until you re-run or re-read it yourself.',
    SECTION_NOTE,
    'Ground truth: ' + PLAN + ' (milestone scope SS18-M3; detail sections ' + CRITIC_SECTIONS + ').',
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
  { id: 'spec-conformance', sections: 'SS11, SS4, SS18-M3',
    charter: 'Line up against SS11 completely: lane/point model shape and real-unit values; taper-mapped vertical axis; snapping on the time axis only; stepped/enum/toggle as steps; lane menu = filtered registry view; deleting frees vs disabling keeps inert; lanes survive device swap kept-greyed-rebindable.' },
  { id: 'dual-path-playback', sections: 'SS11 (Playback), SS12, SS4',
    charter: 'Attack both paths: AudioParam path window fill (setValueAtTime/linearRamp, setValueCurveAtTime chunks for bends — check chunk boundaries do not step or double-schedule); message path 200Hz sampling with worklet interpolation and exact segment-boundary enum/toggle changes; both paths must produce equivalent audible curves for the same lane; path selection follows the binding, not a hardcoded list.' },
  { id: 'live-edit-rescheduling', sections: 'SS11 (Playback)',
    charter: 'Editing a lane DURING playback must cancelAndHoldAtTime from the edit point and reschedule the remainder of the window without clicks, stale ramps, or double-scheduled events. Attack window-boundary edits, edit-during-curve-chunk, rapid consecutive edits, and stop/start races.' },
  { id: 'override-state-machine', sections: 'SS4 (Automated/overridden), SS11',
    charter: 'Exercise every transition: free->automated on lane enable; automated->overridden on user touch DURING playback only (what happens when stopped?); override suspends only that param; Re-enable pill lights on any override and restores all; ghost base dot vs moving live value on the knob; none of this state ever enters the document, undo history, or saved JSON.' },
  { id: 'editor-reuse', sections: 'SS9, SS11 (Editing)',
    charter: 'The automation editor must reuse the M1 canvas kit verbatim: same Viewport, same layer stack, same gesture FSM engine, same snapping infrastructure. Flag ANY parallel gesture handling, ad-hoc canvas rendering, or coordinate math outside the kit as major.' },
  { id: 'test-strategy', sections: 'SS15 (testing)',
    charter: 'Demand: an OfflineAudioContext render asserting an automated sweep landed in the buffer; window-fill unit tests against a mock clock; curve-bend pure-function tests; state-machine transition tests; automation-editor FSM tests from synthetic pointer sequences. Flag gaps as major; do not write tests yourself.' },
];

// ============================ EXECUTION ====================================
const seedFindings = [];

// ---- Phase: Contracts (opus, interface-first) ------------------------------
phase(PH.contracts);
let contracts = await agent(
  [
    'You are the INTERFACE AUTHOR for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton DAW. Parallel implementers will code against your files as a FROZEN contract.',
    SECTION_NOTE,
    'Read ' + PLAN + ' in full, with special care on ' + CRITIC_SECTIONS + '. Then read the existing M0-M2 code under ' + ROOT + '/src to stay consistent with it (especially the ParamRegistry, scheduler window API, and canvas kit).',
    'Write/extend shared TypeScript interface files under ' + ROOT + '/src/types/ (you own that directory): AutoPoint/AutomationLane document types (SS11), the automation sampler interface (window-fill API the SS12 scheduler will call, path-selection contract from SS4 bindings), the override-state events/API the registry exposes to controls and the transport pill, and the lane-editor scene contract for the kit. Interfaces only — no implementations. Must compile under strict tsc.',
    'These packages will implement against your contract, each owning the listed paths exclusively: ' + ALL_PKGS.map((p) => p.id + ' -> ' + p.own.join(' + ')).join('; ') + '. Note override-state owns src/params/ this milestone (registry-internal state machine).',
    'In the schema: interfaceFiles = files you wrote; extraOwnership = optional map pkgId -> additional path prefixes (must not overlap another package); notes = decisions implementers must know, kept short.',
    'SELF-VERIFY: `npx tsc --noEmit` from ' + ROOT + ' passes with your files in place.',
  ].join('\n'),
  { model: M.smart, effort: 'high', label: 'contracts', phase: PH.contracts, schema: CONTRACT_SCHEMA },
);
if (!contracts) {
  log('Contracts agent returned nothing; implementers will fall back to PLAN.md type definitions verbatim.');
  contracts = { interfaceFiles: [], extraOwnership: {}, notes: 'Contracts agent failed. Implement the TypeScript interfaces exactly as written in PLAN.md SS4/SS11 and keep them in your own package.' };
} else {
  log('Contracts frozen: ' + (contracts.interfaceFiles.join(', ') || '(none listed)'));
}
const OWN = grantOwnership(ALL_PKGS, contracts.extraOwnership);

// ---- implementation waves --------------------------------------------------
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

phase(PH.wave1);
const w1 = await runWave('wave 1', PH.wave1, WAVE1);
phase(PH.wave2);
const w2 = await runWave('wave 2', PH.wave2, WAVE2);

// ---- Phase: Integration (opus, single writer) ------------------------------
phase(PH.integration);
const integration = await agent(
  [
    'INTEGRATION agent for milestone ' + MILESTONE + ' ("' + TITLE + '"). All work packages are on disk. You are the only writer; you may edit any file in ' + ROOT + '.',
    SECTION_NOTE,
    'Package reports: ' + JSON.stringify(w1.concat(w2).map((r) => ({ pkg: r.pkg, files: r.filesWritten, summary: r.summary }))),
    'Wire the packages into a working whole: hook the automation sampler into the SS12 scheduler tick (autoSampler.fillWindow(horizon)); connect lane enable/disable to the registry override state machine; mount automation rows in the arrangement view and lane creation in control right-click menus + mixer strips; make the Re-enable pill live in the transport bar. Minimal glue only — no redesigns. Cite PLAN sections for spec-relevant wiring decisions.',
    'MUST end green from ' + ROOT + ': `npx tsc --noEmit`, `npx vitest run`, `npx vite build`. Report honestly; list every file you changed.',
  ].join('\n'),
  { model: M.smart, effort: 'high', label: 'integration', phase: PH.integration, schema: INTEGRATION_SCHEMA },
);
if (!integration || !integration.tscClean || !integration.testsPassed || !integration.buildOk) {
  log('Integration reported problems; seeding blocker finding for the review loop.');
  seedFindings.push({ severity: 'blocker', file: '(integration)', description: 'integration incomplete: ' + (integration ? integration.summary : 'integration agent returned nothing'), planSection: 'SS18-M3', lens: 'spec-conformance' });
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
