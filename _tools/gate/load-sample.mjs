// The sampling half of the load pre-flight, so ONE instrument serves two callers:
// `ko-load-check.mjs` (the pre-flight a lane reads before its heavy step) and
// `ko-timed-suite.mjs` (the wrapper that refuses to grade a suite wall time taken
// on a starved box).
//
// MEASURED 2026-11-27: two copies of this sampler would be two conventions for
// "is the box ready", and the failure this module exists for is exactly the case
// where one caller believed a number the other caller knew was a queue. The pure
// decision stays in `load-verdict.mjs` (no I/O, no clock); this file owns the
// clock and `os.cpus()`, and nothing else.
import os from 'node:os';
import { evaluateLoad } from './load-verdict.mjs';

// TEST ONLY: fixtures substitute deterministic snapshots so both callers are
// testable without depending on the machine's real load. Unset in normal use.
const FIXTURES = ['ready', 'busy', 'cannot'];

function snap() {
  return os.cpus().map((c) => {
    const t = c.times;
    const idle = t.idle;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle, total };
  });
}

function fixturePair(kind, cores) {
  const before = Array.from({ length: cores }, () => ({ idle: 0, total: 1000 }));
  if (kind === 'ready') {
    return [before, Array.from({ length: cores }, () => ({ idle: 1000, total: 2000 }))];
  }
  if (kind === 'busy') {
    return [before, Array.from({ length: cores }, () => ({ idle: 0, total: 2000 }))];
  }
  // 'cannot': identical snapshots, so no counter advances in the window.
  return [before, before.map((s) => ({ ...s }))];
}

// One 1.5 s window, delta-based, no child process and no disk I/O.
export async function readLoad({ sampleMs = 1500, total = 70, core = 90, fixture } = {}) {
  const ceilings = { total, core, windowMs: sampleMs };
  if (fixture !== undefined) {
    if (!FIXTURES.includes(fixture)) return { verdict: 'CANNOT-MEASURE', why: 'bad KO_LOAD_FIXTURE value' };
    const [a, b] = fixturePair(fixture, Math.max(os.cpus().length, 1));
    return evaluateLoad(a, b, ceilings);
  }
  const a = snap();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = snap();
  return evaluateLoad(a, b, ceilings);
}
