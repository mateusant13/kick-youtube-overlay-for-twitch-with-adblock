// vacuous-green-test.mjs — plain-node arms for the vacuous-green gate check.
// Fixtures are plain objects: no suite is spawned and no gate is run.
import { vacuousGreen } from './vacuous-green.mjs';

const suite = (rel, out, status = 'PASS') => ({
  check: 'vacuous-green', rel, status, out,
});
const ctx = (...suiteRuns) => ({ state: { suiteRuns } });

const cases = [
  {
    name: 'checks=0 throws',
    ctx: ctx(suite('kick-overlay/x-test.cjs', 'RESULT PASS x-test checks=0 failed=0')),
    throws: /checks=0/,
  },
  {
    name: 'nonzero checks passes',
    ctx: ctx(suite('kick-overlay/x-test.cjs', 'RESULT PASS x-test checks=95 failed=0')),
  },
  {
    name: 'PASS verdict with no count throws',
    ctx: ctx(suite('kick-overlay/x-test.cjs', 'RESULT PASS x-test: something')),
    throws: /no count signal/,
  },
  {
    name: 'zero arms throws',
    ctx: ctx(suite('kick-overlay/x-test.cjs', 'RESULT PASS x-test ARMS 0/0')),
    throws: /ARMS 0\/0/,
  },
  {
    name: 'unequal arms throws',
    ctx: ctx(suite('kick-overlay/x-test.cjs', 'RESULT PASS x-test ARMS 41/39')),
    throws: /ARMS 41\/39/,
  },
  {
    name: 'real content-fix shape passes',
    ctx: ctx(suite('kick-overlay/content-fix.cjs', 'ARMS 41/41 present\n\nALL CONTENT.JS FIX CHECKS PASSED')),
  },
  {
    name: 'allowlisted no-count suite passes',
    ctx: ctx(suite('kick-overlay/route-gate-test.cjs', 'RESULT PASS route-gate-test')),
  },
  {
    name: 'checks=0 is not excused by nonzero arms',
    ctx: ctx(suite('kick-overlay/x-test.cjs', 'RESULT PASS x-test checks=0 ARMS 41/41')),
    throws: /checks=0/,
  },
  {
    name: 'FAIL-status run is skipped',
    ctx: ctx(suite('kick-overlay/x-test.cjs', 'RESULT FAIL x-test checks=0 failed=1', 'FAIL')),
  },
  {
    name: 'empty suiteRuns returns a detail with 0 suites',
    ctx: ctx(),
    detail: /0 suite\(s\)/,
  },
];

let checks = 0;
let failed = 0;
for (const c of cases) {
  checks++;
  let detail;
  let error;
  try {
    detail = vacuousGreen.run(c.ctx);
  } catch (e) {
    error = e;
  }
  const got = error ? `throw ${error.message}` : `return ${detail}`;
  let ok;
  if (c.throws) ok = error instanceof Error && c.throws.test(error.message);
  else if (c.detail) ok = !error && c.detail.test(String(detail));
  else ok = !error;
  if (!ok) {
    failed++;
    console.error(`FAIL ${c.name}: expected ${c.throws || c.detail || 'no throw'}, got ${got}`);
  }
}

console.log(`RESULT PASS vacuous-green checks=${checks} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
