// vacuous-green.mjs — a suite that passes without declaring work is not a pass.
// The gate runner supplies ctx.state.suiteRuns: one { check, rel, status, out }
// entry per suite it spawned. A thrown Error marks the gate FAIL; the returned
// string is the PASS detail.

// Suites here print a PASS verdict but expose no count signal. One-line reason
// per entry: their exit code and verdict string are the only signal available.
const NO_COUNT_ALLOWLIST = new Map([
  ['kick-overlay/route-gate-test.cjs', 'prints a PASS verdict and no count; rc and verdict string are its only signal'],
  ['kick-overlay/youtube-resume-test.cjs', 'prints a PASS verdict and no count; rc and verdict string are its only signal'],
]);

const CHECKS = /checks=(\d+)/g;
const ARMS = /ARMS (\d+)\/(\d+)/g;
const PASS_VERDICT = /RESULT PASS|ALL CONTENT\.JS FIX CHECKS PASSED/;

export const vacuousGreen = {
  name: 'vacuous-green',
  run(ctx) {
    const runs = ctx?.state?.suiteRuns ?? [];
    let checks = 0;
    let armPairs = 0;

    for (const r of runs) {
      // A failed suite is the suite check's problem, not this check's subject.
      if (r.status !== 'PASS') continue;

      const rel = r.rel;
      const out = String(r.out ?? '');
      let signals = 0;

      for (const m of out.matchAll(CHECKS)) {
        signals++;
        checks++;
        const declared = Number(m[1]);
        if (declared === 0) throw new Error(`${rel}: RESULT PASS with checks=0`);
      }

      for (const m of out.matchAll(ARMS)) {
        signals++;
        armPairs++;
        const present = Number(m[1]);
        const total = Number(m[2]);
        if (present === 0 || total === 0) {
          throw new Error(`${rel}: ARMS ${present}/${total} (zero arm count)`);
        }
        if (present !== total) {
          throw new Error(`${rel}: ARMS ${present}/${total} (unequal arm counts)`);
        }
      }

      if (signals === 0 && PASS_VERDICT.test(out) && !NO_COUNT_ALLOWLIST.has(rel)) {
        throw new Error(`${rel}: no count signal (PASS verdict without checks= or ARMS n/n)`);
      }
    }

    return `${runs.length} suite(s): ${checks} check(s) and ${armPairs} arm pair(s) counted; no PASS with zero checks`;
  },
};
