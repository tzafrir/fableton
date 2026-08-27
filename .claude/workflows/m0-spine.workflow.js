/*
 * m0-spine.workflow.js — Milestone M0 "The spine" (docs/PLAN.md §18-M0).
 * Scaffold (Vite + TS strict + Vitest, worklets as separate entry points),
 * AudioContext boot/unlock, ParamRegistry (§4), device harness + poly synth +
 * filter (§7/§14), transport + look-ahead scheduler with 25ms worker clock (§12),
 * a hard-coded clip audible through a hard-coded chain.
 *
 * MODEL POLICY: sonnet = mechanical implementation (scaffold, boilerplate,
 * template devices, demo wiring, polish); opus = load-bearing seams (§4 registry,
 * §12 scheduler, §7/§14 device harness), contracts, integration, and ALL
 * adversarial review + fix iterations; a FRESH opus verifier = final acceptance gate ONLY, after
 * the opus loop converges. See const M below — used on every agent() call.
 *
 * Browser verification: a Playwright phase (sonnet) runs after integration and
 * seeds its findings into adversarial review round 1; the gate re-runs it.
 *
 * Run standalone:
 *   Workflow({ scriptPath: '/workspaces/fableton/.claude/workflows/m0-spine.workflow.js',
 *              args: { reviewRounds: 3 } })
 * Resume:  Workflow({ scriptPath: <same>, resumeFromRunId: '<runId>' })
 * Normally invoked by daw-build.workflow.js via workflow(); this script must
 * NEVER call workflow() itself (single nesting level).
 *
 * Args: reviewRounds (3), cleanRoundsRequired (1), gateRetries (1),
 *       budgetReserve (0), commitOnPass (true), maxFindingsPerFix (30).
 * Returns: { milestone, pass, blockers, evidence, reviewRoundsUsed,
 *            convergedClean, gateAttempts }
 */

export const meta = {
  name: 'daw-m0-spine',
  description: 'M0 The spine: scaffold, ParamRegistry, device harness + first devices, transport/scheduler, audible hard-coded clip. Ends in an independent opus acceptance gate.',
  phases: [
    { title: 'Scaffold', model: 'sonnet' },
    { title: 'Contracts', model: 'opus' },
    { title: 'Implement: foundation' },
    { title: 'Implement: engine & demo' },
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

const MILESTONE = 'M0';
const TITLE = 'The spine';
const ROOT = '/workspaces/fableton';
const PLAN = ROOT + '/docs/PLAN.md';
const CRITIC_SECTIONS = 'SS3, SS4, SS7, SS8, SS12, SS14, SS15 (stack + testing), SS18-M0';

const A = args || {};
const REVIEW_ROUNDS = A.reviewRounds ?? 3;
const CLEAN_NEEDED = A.cleanRoundsRequired ?? 1;
const GATE_RETRIES = A.gateRetries ?? 1;
const RESERVE = A.budgetReserve ?? 0;
const COMMIT_ON_PASS = A.commitOnPass ?? true;
const MAX_FIX = A.maxFindingsPerFix ?? 30;

const PH = {
  scaffold: 'Scaffold',
  contracts: 'Contracts',
  wave1: 'Implement: foundation',
  wave2: 'Implement: engine & demo',
  integration: 'Integration',
  browser: 'Browser verification',
  review: 'Adversarial review',
  critic: 'Completeness critic',
  gate: 'Acceptance gate',
  checkpoint: 'Checkpoint',
};

function budgetAllows() {
  if (!budget.total) return true; // unset budget: rely on round caps only
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

// ---- work packages (model assignment is the POLICY, stated per package) ----
// own: exclusive write paths (directory prefixes). Disjoint by construction;
// the contracts agent may grant extras, validated for overlap below.
const WAVE1 = [
  { id: 'param-registry', model: M.smart, effort: 'high', own: ['src/params/'],
    sections: 'SS4 (all of it), SS5 (the handle-facing parts), SS3 (the two write paths)',
    brief: 'THE load-bearing seam. ParamRegistry mapping hierarchical ParamId paths to ParamHandle; ParamDescriptor with tapers (linear/log/pow), real-unit value semantics with clamping on load; ParamHandle with base()/live()/setLive(source)/commit(), bindAudioParam (fast path A) and bindMessage (fast path B), onChange coalesced to rAF; free/automated/overridden state kept in the registry (never in the document). Enforce the SS4 design rule: nothing ever exposes a raw AudioParam past a handle.' },
  { id: 'time-model', model: M.code, own: ['src/time/'],
    sections: 'SS8',
    brief: 'Integer Ticks at 960 PPQ (validate integrality in dev), TempoMap as (tick,bpm) segments with piecewise tick<->seconds integration; v1 ships a single fixed-tempo segment but every API takes the map. Include exhaustive unit tests for conversion and grid math.' },
  { id: 'audio-boot', model: M.code, own: ['src/engine/context/'],
    sections: 'SS12 (guardrails), SS2 (platform)',
    brief: 'AudioContext creation with latencyHint "interactive"; unlock/resume on first user gesture (Safari guardrail); AudioWorklet module loading helper that works with Vite worklet entry points in dev and build; expose a boot function returning a ready BaseAudioContext.' },
];
const WAVE2 = [
  { id: 'device-harness', model: M.smart, effort: 'high', own: ['src/devices/harness/'],
    sections: 'SS7, SS14',
    brief: 'DeviceDefinition/DeviceInstance plumbing: create() lifecycle against BaseAudioContext, port wiring (audioIn/audioOut incl. optional sc), connectParam binding local param ids to ParamHandles (AudioParam or message path), deviceInstance() convenience from the SS14 example (audioParams / gainParams / dispose with ramp-out), p.* descriptor factories (p.db, p.hz, p.ms, p.pct, p.st, p.enum) with consistent tapers and toText/fromText, device registry with register/lookup and version field.' },
  { id: 'scheduler-transport', model: M.smart, effort: 'high', own: ['src/engine/transport/', 'src/workers/'],
    sections: 'SS12, SS8, SS3',
    brief: 'Two-clock design: dedicated Worker posting a tick every 25ms; engine schedules to horizon = ctx.currentTime + 0.20 on each tick; event iterator walks clips in tick order unrolling clip loops and the transport loop brace; noteOn/noteOff with exact context timestamps; transport states stopped/playing(/recording flag); stop sends allNotesOff(now+epsilon); zero allocation in per-tick paths (preallocated event objects). Written against BaseAudioContext so the same engine drives OfflineAudioContext export later.' },
  { id: 'device-defs', model: M.code, own: ['src/devices/core/', 'src/worklets/'],
    sections: 'SS7, SS14, SS18-M0',
    brief: 'Two concrete DeviceDefinitions built on the harness + p.* factories: (1) a polyphonic synth instrument — AudioWorkletProcessor or node-per-voice graph, voice allocator behind noteOn/noteOff/allNotesOff, a handful of params (osc shape, cutoff-ish tone, ADSR, gain); (2) a filter audio effect (BiquadFilterNode: type enum, cutoff log-taper Hz, resonance). Worklet files go in src/worklets/ as separate Vite entry points.' },
  { id: 'demo-app', model: M.code, own: ['src/app/', 'src/demo/'],
    sections: 'SS18-M0, SS3',
    brief: 'Minimal React chrome (chrome only, per SS15): a boot/unlock button, play/stop transport buttons; a hard-coded MidiClip (a short musical phrase) played through a hard-coded chain synth -> filter -> destination, audible in the browser. Also a headless integration test: render the same clip through the same chain on an OfflineAudioContext and assert the buffer is non-silent (SS15 testing strategy).' },
];
const ALL_PKGS = WAVE1.concat(WAVE2);

// ---- prompt builders -------------------------------------------------------
// NOTE: 'SS' is used for the section sign in prompts; agents are told it means the section symbol in PLAN.md.
const SECTION_NOTE = 'Notation: "SSn" below means section n (the sign used as section marker) of ' + PLAN + '.';

function implPrompt(pkg, ownedPaths, contracts, siblingIds, retryNote) {
  return [
    'Implement work package "' + pkg.id + '" for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton browser DAW. Repo: ' + ROOT + ' (greenfield).',
    SECTION_NOTE,
    '',
    'SPEC: Read ' + PLAN + ' — at minimum ' + pkg.sections + ' — before writing code. In your summary, cite each PLAN section you implemented (fill planSectionsCited).',
    '',
    'SCOPE: ' + pkg.brief,
    '',
    'SHARED CONTRACTS: conform to the frozen interface files: ' + ((contracts.interfaceFiles || []).join(', ') || '(none listed)') + '. Do NOT modify them. If a contract is wrong or missing, implement against it anyway and flag the problem in your summary. Contract author notes: ' + (contracts.notes || '(none)'),
    '',
    'FILE OWNERSHIP (STRICT — other agents are writing in parallel): create/edit files ONLY under: ' + ownedPaths.join(', ') + '. Read anything you like. Do not touch shared config or create barrel files outside your paths; the integration agent wires packages together afterwards.',
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
    'Ground truth: ' + PLAN + ' (' + lens.sections + '). Inspect the code and tests under ' + ROOT + '; run `npx tsc --noEmit`, `npx vitest run`, or small targeted scripts if that helps you substantiate a defect. Do NOT fix anything and do NOT write files (throwaway probe scripts in the scratchpad are fine).',
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
    'Answer one question exhaustively: what in this milestone\'s spec scope is unimplemented, stubbed, TODO-ed, silently simplified, or untested? Include acceptance-relevant behavior that exists but has no test.',
    'Do NOT fix anything. Severity: blocker = the milestone cannot pass its acceptance gate; major = in-scope spec item missing or untested; minor = polish.',
  ].join('\n');
}

const BROWSER_CHECKS = {
  render: [
    'App loads at the preview URL with ZERO console errors, zero uncaught exceptions, zero failed asset requests.',
    'The boot/unlock control is present and labeled; screenshot the initial state.',
    'The PRODUCTION build actually serves the AudioWorklet module: the worklet chunk request returns 200, not 404 (SS15 calls worklet bundling the only nonstandard bit -- prove it in the built output, not just dev).',
  ],
  interaction: [
    'Click unlock -> AudioContext.state becomes \'running\' (read it via page.evaluate).',
    'Click play -> audio is REALLY produced: tap the graph in-page with an AnalyserNode (or render the same clip through an OfflineAudioContext inside the page) and assert non-zero RMS with energy at the expected note times.',
    'Click stop -> transport stops and RMS decays to silence within ~200ms (SS12 allNotesOff; no stuck notes).',
    'No console errors or unhandled rejections across the whole boot->play->stop flow.',
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
  'Vite + TypeScript strict + Vitest scaffold with AudioWorklet files bundled as separate entry points (SS15): verify a worklet module actually resolves in the build output, not just in dev.',
  'AudioContext boot with latencyHint "interactive" and unlock/resume on first user gesture (SS12 guardrails).',
  'ParamRegistry per SS4: hierarchical string ParamIds, descriptors with tapers, REAL-UNIT values (not normalized) with clamp-on-load, ParamHandle base/live/setLive/commit, bindAudioParam AND bindMessage; grep to confirm no raw AudioParam or setter is exposed past a handle (SS4 design rule).',
  'One polyphonic synth instrument and one filter effect registered as DeviceDefinitions built on the harness and p.* factories (SS7, SS14), with voice allocation behind noteOn/noteOff/allNotesOff.',
  'Transport + look-ahead scheduler per SS12: 25ms clock in a dedicated Worker, ~200ms horizon, events timestamped with context time, allNotesOff on stop, tick<->seconds only via the TempoMap (SS8: integer ticks at 960 PPQ).',
  'End-to-end audible spine: a hard-coded MIDI clip plays through the hard-coded synth->filter chain. Verify via the headless OfflineAudioContext integration test (render + assert non-silent buffer with energy at expected note times) AND by inspecting the demo app wiring.',
  'Browser evidence (Playwright and chromium are preinstalled — do not reinstall): re-run `npx playwright test` yourself from ' + ROOT + ' against a PRODUCTION build preview and confirm it is green. Then OPEN the screenshots under .playwright/screenshots/' + MILESTONE + '/ and confirm they show the real UI rendered — a green test over a blank or unmounted page is a FAIL, not a pass.',
  'Zero console errors, unhandled rejections, or failed asset requests during the e2e flows; audio behavior verified numerically in-page (AnalyserNode RMS or an OfflineAudioContext render), never assumed.',
];

function gatePrompt(openItems, attempt) {
  return [
    'FINAL ACCEPTANCE GATE for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton DAW — attempt ' + attempt + '. You are a VERIFIER, not a fixer: do not modify any project file.',
    'You are INDEPENDENT of everyone who built this milestone and carry no prior context on it: verify from the artifacts alone, and treat every prior agent\'s self-reported result (tests green, criterion met, file written) as an UNVERIFIED CLAIM until you re-run or re-read it yourself.',
    SECTION_NOTE,
    'Ground truth: ' + PLAN + ' (milestone scope SS18-M0; detail sections ' + CRITIC_SECTIONS + ').',
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
  { id: 'spec-conformance', sections: 'SS4, SS7, SS8, SS12, SS14, SS15, SS18-M0',
    charter: 'Line the implementation up against every M0-scope requirement in the cited sections. Hunt silent divergences: normalized values stored instead of real units; ParamIds that are not hierarchical document-id paths; a scheduler written against AudioContext instead of BaseAudioContext; non-integer ticks or a PPQ other than 960; worklets not bundled as separate entry points.' },
  { id: 'seam-integrity', sections: 'SS3, SS4 (design rule), SS7',
    charter: 'Hunt leaks across the sanctioned seams: any raw AudioParam or setter reachable past a ParamHandle; engine code reaching back into the document; device internals known outside their definition; UI writing through anything but commands or handle.setLive.' },
  { id: 'audio-thread-safety', sections: 'SS12 (guardrails), SS7, SS2 (performance)',
    charter: 'Hunt audio-thread hazards: allocation in per-tick paths; scheduling from JS-timer time instead of ctx.currentTime; missing allNotesOff on stop; worklet message races; clicks from un-ramped gain changes; main-thread work that can starve the 25ms worker clock.' },
  { id: 'correctness-edges', sections: 'SS8, SS12, SS7',
    charter: 'Hunt logic bugs at the edges: voice stealing and noteOn/noteOff pairing; look-ahead window boundaries duplicating or dropping events; clip-loop unrolling off-by-one in ticks; tempo conversion rounding; context unlock/resume re-entrancy; double-start or stop-while-starting transport races.' },
  { id: 'test-strategy', sections: 'SS15 (testing)',
    charter: 'Judge the tests against SS15: a headless OfflineAudioContext integration test must render a scheduled clip and assert on the buffer; registry, tapers, tempo map, and scheduler must be unit-tested without a browser. Flag load-bearing logic with no test as major. Do not write the tests yourself — report the gap.' },
];

// ============================ EXECUTION ====================================
const seedFindings = [];

// ---- Phase: Scaffold (sonnet, runs alone — no ownership contention) --------
phase(PH.scaffold);
const scaffold = await agent(
  [
    'Scaffold the Fableton web DAW project at ' + ROOT + ' (currently only README.md and docs/). Milestone ' + MILESTONE + '.',
    SECTION_NOTE,
    'Read ' + PLAN + ' SS15 (stack table) and SS18-M0 first; cite them in your summary.',
    'Deliver: package.json (npm), Vite + React + TypeScript STRICT (all strict flags), Vitest configured for headless node/jsdom tests, worklet/worker bundling solved ONCE as separate entry points (SS15 calls this the only nonstandard bit — prove it with a tiny placeholder AudioWorkletProcessor entry that builds), index.html, src/main.tsx placeholder that mounts an empty React root, .gitignore, and a smoke test.',
    'Folder skeleton (empty dirs seeded with .gitkeep or placeholder modules): src/params, src/time, src/engine/context, src/engine/transport, src/workers, src/worklets, src/devices/harness, src/devices/core, src/app, src/demo, src/types.',
    'ALSO set up the shared Playwright e2e harness that every later milestone builds on (Playwright + chromium are ALREADY INSTALLED — never run `npx playwright install`): add @playwright/test to devDependencies, write playwright.config.ts (chromium project, deviceScaleFactor 2 so DPR-correct canvas rendering is testable, launch arg --autoplay-policy=no-user-gesture-required so audio starts headlessly, screenshots/traces on failure, webServer pointing at a PRODUCTION build preview), create e2e/render/ and e2e/interaction/ with one trivial passing spec each, add npm scripts test:e2e and preview, and gitignore .playwright/ and test-results/.',
    'CRITICAL for SS6 metering later: configure BOTH the Vite dev server and vite preview to send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, so crossOriginIsolated is true and SharedArrayBuffer is available (verified working in this environment). Assert it in the e2e smoke spec.',
    'SELF-VERIFY: `npm install`, `npx tsc --noEmit`, `npx vitest run`, `npx vite build` AND `npx playwright test` all succeed from ' + ROOT + '. Report honestly.',
  ].join('\n'),
  { model: M.code, label: 'scaffold', phase: PH.scaffold, schema: IMPL_SCHEMA },
);
if (!scaffold || !scaffold.tscClean) {
  log('Scaffold reported problems (' + (scaffold ? scaffold.summary : 'no result') + '); seeding a blocker finding for the review loop.');
  seedFindings.push({ severity: 'blocker', file: 'package.json', description: 'scaffold incomplete or tsc unclean: ' + (scaffold ? scaffold.summary : 'scaffold agent returned nothing'), planSection: 'SS15', lens: 'spec-conformance' });
}

// ---- Phase: Contracts (opus, interface-first) ------------------------------
phase(PH.contracts);
let contracts = await agent(
  [
    'You are the INTERFACE AUTHOR for milestone ' + MILESTONE + ' ("' + TITLE + '") of the Fableton DAW. Parallel implementers will code against your files as a FROZEN contract.',
    SECTION_NOTE,
    'Read ' + PLAN + ' in full (it is the complete spec), with special care on ' + CRITIC_SECTIONS + '.',
    'Write shared TypeScript interface/type files under ' + ROOT + '/src/types/ (you own that directory): ParamId/ParamDescriptor/ParamHandle/Taper (SS4 verbatim), DeviceDefinition/DeviceInstance/PortSpec/DeviceIO (SS7), Ticks/TempoMap (SS8), transport + scheduler-facing types (SS12), and the minimal Note/MidiClip needed for the hard-coded M0 clip (SS10 data model). Interfaces only — no implementations. Everything must compile under strict tsc.',
    'These packages will implement against your contract, each owning the listed paths exclusively: ' + ALL_PKGS.map((p) => p.id + ' -> ' + p.own.join(' + ')).join('; ') + '.',
    'In the schema: interfaceFiles = the files you wrote; extraOwnership = optional map pkgId -> additional path prefixes a package needs beyond its defaults (must not overlap another package); notes = decisions implementers must know (naming, import layout, invariants), kept short.',
    'SELF-VERIFY: `npx tsc --noEmit` from ' + ROOT + ' passes with your files in place.',
  ].join('\n'),
  { model: M.smart, effort: 'high', label: 'contracts', phase: PH.contracts, schema: CONTRACT_SCHEMA },
);
if (!contracts) {
  log('Contracts agent returned nothing; implementers will fall back to PLAN.md type definitions verbatim.');
  contracts = { interfaceFiles: [], extraOwnership: {}, notes: 'Contracts agent failed. Implement the TypeScript interfaces exactly as written in PLAN.md SS4/SS7/SS8/SS10 and keep them in your own package.' };
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
    'Wire the packages into a working whole: entry points, cross-package imports, registry wiring (register the synth + filter definitions), the demo app path (boot -> unlock -> play the hard-coded clip through synth->filter, audibly), and the headless OfflineAudioContext integration test. Minimal glue only — no redesigns, no new features. Cite PLAN sections for spec-relevant wiring decisions.',
    'MUST end green from ' + ROOT + ': `npx tsc --noEmit`, `npx vitest run`, `npx vite build`. Report honestly; list every file you changed.',
  ].join('\n'),
  { model: M.smart, effort: 'high', label: 'integration', phase: PH.integration, schema: INTEGRATION_SCHEMA },
);
if (!integration || !integration.tscClean || !integration.testsPassed || !integration.buildOk) {
  log('Integration reported problems; seeding blocker finding for the review loop.');
  seedFindings.push({ severity: 'blocker', file: '(integration)', description: 'integration incomplete: ' + (integration ? integration.summary : 'integration agent returned nothing'), planSection: 'SS18-M0', lens: 'spec-conformance' });
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

// ---- Phase: Checkpoint (sonnet commit so later milestones/M4 metric have a baseline)
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
