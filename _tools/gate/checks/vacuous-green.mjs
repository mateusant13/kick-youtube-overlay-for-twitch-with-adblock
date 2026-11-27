// vacuous-green.mjs — a suite that passes without declaring work is not a pass.
// The gate runner supplies ctx.state.suiteRuns: one { check, rel, status, out }
// entry per suite it spawned. A thrown Error marks the gate FAIL; the returned
// string is the PASS detail.

// Suites here print a PASS verdict but expose no count signal. One-line reason
// per entry: their exit code and verdict string are the only signal available.
//
// MEASURED 2026-11-27: BOTH original entries were stale and are gone.
// `route-gate-test.cjs` already printed `ANTI-VACUITY suite=route-gate checks=39
// expected=39`, which the CHECKS regex below matches, so its entry excused a
// suite that could already prove its count - and would have excused the same
// suite at `checks=0` if its own anti-vacuity line were ever deleted.
// `youtube-resume-test.cjs` printed `arms=2 expected=2`, which the ARMS regex
// (`ARMS n/m`) did NOT match; it now prints the canonical `ARMS 2/2 present`.
// An entry here is a permanent exemption from the count requirement, so a stale
// one is a false green that never expires.
const NO_COUNT_ALLOWLIST = new Map([]);

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
