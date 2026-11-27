// ---- 7. revival gates ------------------------------------------------------
// The project-revival artifacts (features/, benchmarks/, revival/) are gates,
// not paperwork: a feature map that drifted from the tree and a budget row
// whose command is empty are both silent unless a check reads them. All three
// are cheap (0.35 s, 0.37 s, 0.09 s measured 2026-11-26) because the heavy
// metric (the full gate wall) is a LANDING measurement, never a self-measure:
// `benchmark_history run --tier basic` runs the parser and the census only.
//
// The scripts live in the shared skills root, so the path is overridable and
// a missing interpreter is a FAIL, never a skip: an unread gate that reports
// nothing is the silent-green class this file exists to refuse.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REVIVAL_SCRIPTS = process.env.REVIVAL_SCRIPTS
  || 'C:/Users/Administrador/.agents/skills/project-revival/scripts';

function revivalScript(ctx, name) {
  const p = path.join(REVIVAL_SCRIPTS, name);
  ctx.assert(existsSync(p), `missing ${p} (set REVIVAL_SCRIPTS)`);
  return p;
}

function runRevival(ctx, name, args) {
  const r = spawnSync('python', [revivalScript(ctx, name), ...args], { cwd: ctx.ROOT, encoding: 'utf8' });
  const out = String(r.stdout || '') + String(r.stderr || '');
  return { rc: r.status, out };
}

export const revivalChecks = [
  {
    name: 'revival-features',
    run(ctx) {
      const { rc, out } = runRevival(ctx, 'feature_map_sync.py', ['--repo', ctx.ROOT, '--gate']);
      ctx.assert(rc === 0, `feature map drifted from the tree:\n${out.trim().slice(-600)}`);
      ctx.assert(/"verdict":\s*"PASS"/.test(out), `feature gate printed no verdict:\n${out.trim().slice(-400)}`);
      const problems = /"problems":\s*\[(.*?)\]/s.exec(out);
      ctx.assert(problems && problems[1].trim() === '', `feature gate listed problems: ${problems && problems[1].trim().slice(0, 400)}`);
      const map = JSON.parse(ctx.read('features/features.json'));
      const features = Array.isArray(map.features) ? map.features : [];
      const empty = features.filter((f) => !f.how_it_works || !f.inputs || !f.outputs);
      ctx.assert(empty.length === 0, `feature(s) missing how_it_works/inputs/outputs: ${empty.map((f) => f.id || f.name).join(', ')}`);
      return `${features.length} feature(s) match the tree, each with inputs/outputs/how_it_works`;
    },
  },
  {
    name: 'revival-budgets',
    run(ctx) {
      const { rc, out } = runRevival(ctx, 'benchmark_history.py', [
        'run', '--repo', ctx.ROOT, '--tier', 'basic', '--gate', '--no-record', '--label', 'gate-basic',
      ]);
      ctx.assert(rc === 0, `a basic metric is over its ceiling or unmeasured:\n${out.trim().slice(-700)}`);
      const ids = [...out.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
      ctx.assert(ids.length > 0, `benchmark gate printed no metric row:\n${out.trim().slice(-400)}`);
      return `${ids.length} basic metric(s) inside budget (${ids.join(', ')})`;
    },
  },
  {
    name: 'revival-friction',
    run(ctx) {
      // `measure` re-runs every row's verify_cmd and WRITES the new timings into
      // revival/FRICTION.json. A gate that edits a tracked file leaves the tree
      // dirty and, worse, can resurrect a row set older than HEAD (measured
      // 2026-11-26: a gate started before five lane landings rewrote the file
      // back to the pre-landing rows). The measurement is kept, the write is not:
      // the bytes are restored and the restore itself is asserted.
      const rel = 'revival/FRICTION.json';
      const abs = path.join(ctx.ROOT, rel);
      const before = readFileSync(abs, 'utf8');
      let rc;
      let out;
      try {
        ({ rc, out } = runRevival(ctx, 'loop_friction_audit.py', ['measure', '--repo', ctx.ROOT, '--gate']));
      } finally {
        if (readFileSync(abs, 'utf8') !== before) writeFileSync(abs, before);
      }
      ctx.assert(readFileSync(abs, 'utf8') === before,
        `${rel} was rewritten by the measure and the restore did not take`);
      ctx.assert(rc === 0, `inner-loop friction is open or over budget:\n${out.trim().slice(-700)}`);
      const m = /"verdict":\s*"PASS"/.exec(out);
      ctx.assert(m, `friction audit printed no verdict:\n${out.trim().slice(-400)}`);
      // A row that went over its target WHILE THE BOX WAS ABOVE ITS CEILING is a
      // CANNOT-MEASURE, and the audit says so instead of failing the tree: the
      // same command read 6.1 s and 17.9 s (min of four) minutes apart on
      // 2026-11-26 with 8 cores pinned by foreign lanes. Naming it here keeps the
      // refusal visible; a quiet box still fails on `OVER_BUDGET`.
      const starvedBlock = /"starved":\s*\[([^\]]*)\]/.exec(out);
      const starved = starvedBlock ? (starvedBlock[1].match(/":/g) || []).length : 0;
      const loadBlock = /"load":\s*\{[^}]*"total":\s*([\d.]+),[^}]*"busiest":\s*([\d.]+)/.exec(out);
      const load = loadBlock ? `total ${loadBlock[1]}% busiest ${loadBlock[2]}%` : 'load unread';
      return starved
        ? `${starved} row(s) CANNOT-MEASURE at load ceiling (${load}); every other row inside target (tree left byte-identical)`
        : 'every friction row has a verify_cmd that runs inside its target (tree left byte-identical)';
    },
  },
];
