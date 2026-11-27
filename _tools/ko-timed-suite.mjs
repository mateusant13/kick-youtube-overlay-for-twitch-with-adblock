#!/usr/bin/env node
// A SUITE'S WALL TIME IS ONLY A MEASUREMENT IF THE BOX COULD RUN IT.
//
// MEASURED 2026-11-27: `revival_verify.py` graded `subsystem.ad_time_continuity_ms` at
// 16 923.85 ms against a 5 963.49 ms baseline and called it REGRESSED +183.8%, while the
// same metric's own budget note records 4 235 ms in a quiet window and names the
// contended pair (12 979 / 16 493 ms with two siblings on the SMR volume) as "the queue
// and not the instrument". The box at that moment read `{"total":61.5,"busiest":100,
// "pinned":8}` - all 8 E-cores pinned - and no product file had changed in the commits
// being verified. Three samples were taken (the tool already keeps the min of N), so the
// estimator was not the defect: the instrument graded a queue.
//
// The project's own law is that a reading on a starved box is CANNOT-MEASURE, never a
// red. This wrapper is that law as code, in the metric's own command: it reads the same
// pre-flight every lane reads (`gate/load-sample.mjs`, one instrument, two callers) and
// either
//   - emits a typed refusal (`latency_refused`, which `benchmark_history.py` turns into
//     CANNOT-MEASURE rather than a value), or
//   - runs the suite once, streams its output, and prints `RESULT_MS=<suite wall>` for
//     the regex parser.
//
// What it deliberately does NOT do: widen a tolerance, skip the suite silently, or hide
// a real regression. A slow suite on a READY box still prints its number and still
// regresses the metric.
//
//   node _tools/ko-timed-suite.mjs                 # default: the ad-time-continuity suite
//   node _tools/ko-timed-suite.mjs --suite "node kick-overlay/x.cjs" --label x
//
// Exit codes: 0 refusal emitted (NOT measured, and never graded), otherwise the suite's
// own code. A suite that fails is a FAIL, not a refusal.
import { spawnSync } from 'node:child_process';
import { readLoad } from './gate/load-sample.mjs';

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const SUITE = argOf('--suite', 'node kick-overlay/ad-time-continuity-test.cjs');
const LABEL = argOf('--label', 'ad_time_continuity');
const SAMPLE_MS = Number(process.env.KO_LOAD_SAMPLE_MS || 1500);
const MAX_TOTAL = Number(process.env.KO_LOAD_MAX_TOTAL || 70);
const MAX_CORE = Number(process.env.KO_LOAD_MAX_CORE || 90);

const load = await readLoad({
  sampleMs: SAMPLE_MS,
  total: MAX_TOTAL,
  core: MAX_CORE,
  fixture: process.env.KO_LOAD_FIXTURE,
});

// READY is the only state in which a wall time means anything. BUSY and CANNOT-MEASURE
// both refuse, and the reason carries the numbers so the receipt answers "why".
if (load.verdict !== 'READY') {
  const why =
    load.verdict === 'BUSY'
      ? `starved: total=${load.total}% busiest=${load.busiest}% pinned=${load.pinned} (ceilings total ${MAX_TOTAL}%, core ${MAX_CORE}%)`
      : `no cpu reading: ${load.why || 'unknown'} (window ${SAMPLE_MS}ms)`;
  console.log(JSON.stringify({
    latency_refused: true,
    latency_refused_reason: why,
    suite: LABEL,
    command: SUITE,
    verdict: 'CANNOT-MEASURE',
    load,
  }));
  process.exit(0);
}

const t0 = process.hrtime.bigint();
// Bounded on purpose: an unwrapped `spawnSync` is a hang site, and this repo's own
// fail-fast audit refuses one (measured 2026-11-27: the gate named
// `_tools/ko-timed-suite.mjs js.spawn_no_timeout` on the first run). The suite's own
// ceiling is 60 s in budgets.json, so 300 s is the kill line, not a budget.
const SUITE_TIMEOUT_MS = Number(process.env.KO_SUITE_TIMEOUT_MS || 300000);
const child = spawnSync(SUITE, { shell: true, encoding: 'utf8', timeout: SUITE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
const suiteMs = Number(process.hrtime.bigint() - t0) / 1e6;

// The suite's own output goes to stderr: its stdout is a receipt the parser reads, and a
// refusal token appearing anywhere before the number would turn a measurement into a
// maybe. A caller that pipes stdout gets exactly one RESULT_MS line plus the verdict.
if (child.stdout) process.stderr.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);

if (child.status !== 0) {
  const rc = child.status === null ? `timeout>${SUITE_TIMEOUT_MS}ms` : child.status;
  console.log(`RESULT FAIL ${LABEL} rc=${rc} ms=${Math.round(suiteMs)} load_ready=1`);
  process.exit(child.status === null ? 1 : child.status);
}

console.log(`RESULT_MS=${Math.round(suiteMs)}`);
console.log(`RESULT PASS ${LABEL} ms=${Math.round(suiteMs)} load_ready=1`);
process.exit(0);
