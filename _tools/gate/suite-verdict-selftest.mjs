// WHY THIS EXISTS. `_tools/gate/checks/suites.mjs` reported every suite from
// `r.status === 0` alone, so a suite that printed `RESULT FAIL ... failed=1` and
// exited 0 read as PASS in the receipt. Measured 2026-11-27 on this repo. The
// gate now requires rc 0 AND the last printed `RESULT` line to be `RESULT PASS`;
// this file proves both directions with real children, and that the suite runner
// actually calls the check (a helper nobody calls is decoration).
//
// Real children, not mocks: a fixture that prints a red verdict and exits 0 is
// exactly the shape that used to pass. Fixtures live on the declared scratch
// root and are deleted by exact path.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { assertPrintedVerdict } from './checks/suites.mjs';

const SCRATCH = process.env.KO_SELFTEST_ROOT || 'G:/Temp/ko-scratch/suite-verdict-selftest';
let checks = 0;
let failed = 0;

function ok(cond, name) {
  checks += 1;
  if (cond) {
    console.log(`ok ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}`);
  }
}

const ctx = {
  assert(c, m) {
    if (!c) throw new Error(m);
  },
};

function decision(r, rel) {
  try {
    assertPrintedVerdict(ctx, r, rel);
    return 'accept';
  } catch {
    return 'refuse';
  }
}

function realChild(name, body) {
  mkdirSync(SCRATCH, { recursive: true });
  const file = path.join(SCRATCH, name);
  writeFileSync(file, body);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30000 });
  rmSync(file, { force: true });
  return r;
}

// 1. THE DEFECT ITSELF: a printed FAIL under rc 0 used to be green.
const red = realChild('red-under-rc0.cjs',
  "console.log('RESULT FAIL demo-suite checks=2 failed=1');\n");
ok(red.status === 0, 'fixture exits 0 while printing a red verdict');
ok(decision(red, 'demo-suite') === 'refuse', 'rc 0 with a printed RESULT FAIL is REFUSED');

// 2. The green direction still passes, or the check would redden every real suite.
const green = realChild('green-under-rc0.cjs',
  "console.log('ARMS 3/3');\nconsole.log('RESULT PASS demo-suite checks=2 failed=0');\n");
ok(green.status === 0 && decision(green, 'demo-suite') === 'accept', 'rc 0 with a printed RESULT PASS is ACCEPTED');

// 3. A non-zero rc is still a refusal, whatever the child printed.
ok(decision({ status: 2, stdout: 'RESULT PASS demo-suite checks=2 failed=0' }, 'demo-suite') === 'refuse',
  'rc 2 with a printed RESULT PASS is REFUSED');

// 4. No verdict line at all is not a pass: a child that dies before printing says nothing.
ok(decision({ status: 0, stdout: 'ARMS 3/3\n' }, 'demo-suite') === 'refuse',
  'rc 0 with no RESULT line is REFUSED');

// 5. The last verdict wins, so a suite that prints PASS and later FAILs is red.
ok(decision({ status: 0, stdout: 'RESULT PASS x checks=1 failed=0\nRESULT FAIL x checks=2 failed=1\n' }, 'x') === 'refuse',
  'the LAST printed verdict decides');

// 6. The runner calls it. A helper that no call site reaches is a false green.
const runner = (await import('node:fs')).readFileSync(new URL('./checks/suites.mjs', import.meta.url), 'utf8');
ok(/assertPrintedVerdict\(ctx, r, rel\)/.test(runner), 'runSuite calls assertPrintedVerdict for every suite');

console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} suite-verdict checks=${checks} failed=${failed} arms=6/6`);
process.exitCode = failed ? 1 : 0;
