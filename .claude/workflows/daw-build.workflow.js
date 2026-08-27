/*
 * daw-build.workflow.js — TOP-LEVEL ORCHESTRATOR for the Fableton web DAW build.
 *
 * What it does: runs the five milestone workflows (docs/PLAN.md §18, M0–M4) in
 * dependency order, each as ONE nested workflow() call (milestone scripts never
 * call workflow() themselves — one level of nesting only). Collects each
 * milestone's acceptance-gate verdict { pass, blockers, evidence } and returns a rollup.
 *
 * MODEL POLICY (user-mandated; every agent() in every script encodes it):
 *   sonnet — direct/mechanical implementation: scaffolding, configs, boilerplate,
 *            §14-template device definitions, type decls, fixtures, repetitive
 *            per-item work, formatting/lint fixes.
 *   opus   — intelligent implementation: load-bearing seams (§4 params, §6
 *            routing/reconciler, §9 editor kit), §10 piano-roll FSM, §11 dual
 *            automation playback paths, §12 scheduler, §13 command/patch/undo,
 *            cross-cutting design decisions, and ALL adversarial review + fix
 *            iterations.
 *   gate   — the final milestone gate is a FRESH opus agent, run only after the
 *            opus review/fix loop has converged. Verifies acceptance criteria,
 *            runs build/tests, returns pass/fail + concrete blockers. Never
 *            implements, and carries no prior context on the implementation.
 *   NO FABLE — fable agents are used nowhere in this build (out of fable budget
 *            for this project). Every agent() call is sonnet or opus.
 *
 * BROWSER VERIFICATION: Playwright + chromium are preinstalled on this machine.
 * Every milestone runs a sonnet Playwright phase after integration (render probe
 * + interaction probe, disjoint e2e/ paths); its findings and any console errors
 * seed adversarial review round 1, and the acceptance gate re-runs the suite and
 * inspects the screenshots. Audio is verified numerically in-page (AnalyserNode
 * RMS / OfflineAudioContext renders), never assumed.
 *
 * Run:
 *   Workflow({ scriptPath: '/workspace/fableton/.claude/workflows/daw-build.workflow.js',
 *              args: { milestones: ['M0','M1','M2','M3','M4'], reviewRounds: 3 } })
 * Resume:
 *   Workflow({ scriptPath: <same>, resumeFromRunId: '<runId>' })
 *
 * Args (all optional):
 *   milestones          string[] — subset to run (canonical order is enforced); default all five
 *   reviewRounds        number   — max adversarial review rounds per milestone (default 3)
 *   cleanRoundsRequired number   — consecutive clean review rounds needed to converge (default 1)
 *   gateRetries         number   — acceptance-gate fail -> opus blocker-fix -> re-gate cycles (default 1)
 *   budgetReserve       number   — stop starting new work when budget.remaining() <= this
 *                                  (same units as budget.total; only enforced when budget.total is set)
 *   stopOnFail          boolean  — halt the milestone sequence on a failed gate (default true)
 *   commitOnPass        boolean  — git-commit a checkpoint after each passed gate (default true;
 *                                  M4's touch-metric review lens depends on these baselines)
 *   maxFindingsPerFix   number   — cap of findings handed to one fixer agent (default 30; overflow logged)
 */

export const meta = {
  name: 'daw-build',
  description: 'Orchestrates the M0-M4 build of the Fableton web DAW per docs/PLAN.md, one nested milestone workflow at a time, each ending in an independent opus acceptance gate.',
  phases: [
    { title: 'Preflight', model: 'sonnet' },
    { title: 'M0 — The spine' },
    { title: 'M1 — Editors' },
    { title: 'M2 — Mixer & routing' },
    { title: 'M3 — Automation' },
    { title: 'M4 — Library & finish' },
    { title: 'Rollup' },
  ],
};

const A = args || {};
const KNOBS = {
  reviewRounds: A.reviewRounds ?? 3,
  cleanRoundsRequired: A.cleanRoundsRequired ?? 1,
  gateRetries: A.gateRetries ?? 1,
  budgetReserve: A.budgetReserve ?? 0,
  commitOnPass: A.commitOnPass ?? true,
  maxFindingsPerFix: A.maxFindingsPerFix ?? 30,
};
const STOP_ON_FAIL = A.stopOnFail ?? true;

const WF = '/workspace/fableton/.claude/workflows';
const CANON = [
  { id: 'M0', phase: 'M0 — The spine',       script: WF + '/m0-spine.workflow.js',         deps: [] },
  { id: 'M1', phase: 'M1 — Editors',          script: WF + '/m1-editors.workflow.js',       deps: ['M0'] },
  { id: 'M2', phase: 'M2 — Mixer & routing',  script: WF + '/m2-mixer-routing.workflow.js', deps: ['M0', 'M1'] },
  { id: 'M3', phase: 'M3 — Automation',       script: WF + '/m3-automation.workflow.js',    deps: ['M0', 'M1', 'M2'] },
  { id: 'M4', phase: 'M4 — Library & finish', script: WF + '/m4-library.workflow.js',       deps: ['M0', 'M1', 'M2', 'M3'] },
];

// ---------------------------------------------------------------- preflight
phase('Preflight');
const pre = await agent(
  [
    'Preflight for the Fableton DAW build workflow. Do NOT write or modify any file.',
    'Check and report:',
    '  1. /workspace/fableton/docs/PLAN.md exists and is readable.',
    '  2. `git -C /workspace/fableton status --porcelain` (is the tree clean?) and `git -C /workspace/fableton log --oneline -3`.',
    '  3. `node --version` and `npm --version` work.',
    '  4. Whether /workspace/fableton already has package.json, vite.config.*, or src/ (evidence of prior milestone runs) — list what exists.',
    'Return ok=true only if PLAN.md exists and node+npm are available.',
  ].join('\n'),
  {
    model: 'sonnet', effort: 'low', label: 'preflight', phase: 'Preflight',
    schema: {
      type: 'object', required: ['ok', 'notes'],
      properties: { ok: { type: 'boolean' }, notes: { type: 'string' }, priorBuildDetected: { type: 'boolean' } },
    },
  },
);
if (!pre || !pre.ok) {
  log('Preflight failed: ' + (pre ? pre.notes : 'preflight agent returned no result') + ' — aborting.');
  return { aborted: true, reason: pre ? pre.notes : 'preflight agent failed', verdicts: [] };
}
log('Preflight OK. ' + pre.notes);

// -------------------------------------------------------- milestone selection
const requested = Array.isArray(A.milestones) && A.milestones.length > 0
  ? A.milestones.map((s) => String(s).toUpperCase())
  : CANON.map((m) => m.id);
const unknown = requested.filter((id) => !CANON.some((m) => m.id === id));
if (unknown.length) log('Ignoring unknown milestone ids: ' + unknown.join(', '));
const selected = new Set(requested.filter((id) => CANON.some((m) => m.id === id)));
log('Milestones to run (canonical order): ' + CANON.filter((m) => selected.has(m.id)).map((m) => m.id).join(', '));

// ------------------------------------------------------------ milestone loop
const verdicts = [];
let halted = null;
for (const m of CANON) {
  phase(m.phase);
  if (!selected.has(m.id)) { log(m.id + ': skipped (not in args.milestones).'); continue; }
  if (halted) { log(m.id + ': skipped (' + halted + ').'); continue; }

  const unmet = m.deps.filter((d) => !verdicts.some((v) => v.milestone === d && v.pass));
  const notSelected = unmet.filter((d) => !selected.has(d));
  if (notSelected.length) {
    log(m.id + ': deps ' + notSelected.join(', ') + ' not selected this run — assuming they exist in the tree from a previous run (advisory only).');
  }

  if (budget.total && budget.remaining() <= KNOBS.budgetReserve) {
    halted = 'budget reserve reached before ' + m.id + ' (remaining ' + budget.remaining() + ')';
    log(halted + ' — not starting further milestones.');
    continue;
  }

  log(m.id + ': launching nested milestone workflow ' + m.script);
  let verdict = null;
  try {
    verdict = await workflow({ scriptPath: m.script }, { ...KNOBS });
  } catch (e) {
    log(m.id + ': milestone workflow threw: ' + (e && e.message ? e.message : String(e)));
  }
  if (!verdict || typeof verdict.pass !== 'boolean') {
    verdict = { milestone: m.id, pass: false, blockers: ['milestone workflow returned no structured verdict'], evidence: '' };
  }
  verdicts.push(verdict);
  log(m.id + ' gate: ' + (verdict.pass ? 'PASS' : 'FAIL')
    + (verdict.blockers && verdict.blockers.length ? ' — blockers: ' + verdict.blockers.join(' | ') : '')
    + (verdict.convergedClean === false ? ' [review loop did NOT converge clean]' : ''));
  if (!verdict.pass && STOP_ON_FAIL) halted = 'stopOnFail after ' + m.id + ' gate failure';
}

// ------------------------------------------------------------------- rollup
phase('Rollup');
const rollup = {
  plan: '/workspace/fableton/docs/PLAN.md (rev 1)',
  requested: CANON.filter((m) => selected.has(m.id)).map((m) => m.id),
  verdicts,
  allPassed: verdicts.length > 0 && verdicts.every((v) => v.pass) && !halted,
  halted,
  budget: {
    total: budget.total,
    spent: budget.spent(),
    remaining: budget.total ? budget.remaining() : null,
  },
};
log('Rollup: ' + (verdicts.length
  ? verdicts.map((v) => v.milestone + ':' + (v.pass ? 'PASS' : 'FAIL')).join('  ')
  : 'no milestones ran') + (halted ? '  (halted: ' + halted + ')' : ''));
return rollup;
