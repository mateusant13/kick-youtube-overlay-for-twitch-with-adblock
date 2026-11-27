#!/usr/bin/env node
// ARMS FOR THE ONE DEFINITION OF "THIS BUG CLAIMS VERIFICATION".
//
// MEASURED 2026-11-27 (audit A3GateRevival): `ledger-evidence` decided the
// concept from `verified`, `verified-artifacts` decided it from `state`, and the
// receipt decided FIXED-NOT-VERIFIED from `state === 'fixed' && verified !== true`.
// Three predicates, one question. A row with `state:'fixed', verified:true` was
// counted as verified-with-evidence, skipped by the artifact binding, and absent
// from the warning list: a claim with no artifact and no notice.
//
//   1. agreement  -> state verified + verified true is one claim on both sides
//   2. fixed/idle -> state fixed + verified false is work in progress on both sides
//   3. RED: stale -> state fixed + verified true counts as verified while carrying
//                    no binding, which is the divergence the invariant refuses
//   4. state-only -> state verified + verified false carries a binding but claims
//                    no verification, the other direction of the same hole
import { carriesArtifactBinding, describeVerification, isVerifiedClaim } from './bug-state.mjs';

let checks = 0;
let failed = 0;
const lines = [];
function arm(name) {
  lines.push(`  arm  ${name}`);
}
function ok(cond, label, detail = '') {
  checks += 1;
  if (cond) lines.push(`  ok   ${label}`);
  else {
    failed += 1;
    lines.push(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

const diverges = (bug) => isVerifiedClaim(bug) !== carriesArtifactBinding(bug);

// ---------------------------------------------------------------- arm 1
arm('agreement');
{
  const bug = { id: 'KO-T1', state: 'verified', verified: true };
  ok(isVerifiedClaim(bug) === true, 'verified:true is a verification claim');
  ok(carriesArtifactBinding(bug) === true, 'state verified carries an artifact binding');
  ok(diverges(bug) === false, 'the two sides agree');
  const dated = { id: 'KO-T1b', state: 'arm-verified', verified: '2026-11-27' };
  ok(isVerifiedClaim(dated) === true, 'a YYYY-MM-DD verified value is also a claim');
  ok(diverges(dated) === false, 'a dated claim on an arm-verified row agrees');
}

// ---------------------------------------------------------------- arm 2
arm('fixed/idle');
{
  const bug = { id: 'KO-T2', state: 'fixed', verified: false };
  ok(isVerifiedClaim(bug) === false, 'verified:false makes no claim');
  ok(carriesArtifactBinding(bug) === false, 'state fixed carries no artifact binding');
  ok(diverges(bug) === false, 'the two sides agree that nothing is verified');
  const absent = { id: 'KO-T2b', state: 'reproduced' };
  ok(isVerifiedClaim(absent) === false && diverges(absent) === false, 'an absent verified field agrees');
}

// ---------------------------------------------------------------- arm 3 (RED)
arm('RED: fixed but verified');
{
  const bug = { id: 'KO-T3', state: 'fixed', verified: true };
  ok(isVerifiedClaim(bug) === true, 'RED precondition: the old ledger predicate counts this row as verified');
  ok(carriesArtifactBinding(bug) === false, 'RED precondition: the artifact predicate skips the same row');
  ok(
    diverges(bug) === true,
    'RED: the divergence is real, so the invariant would refuse it instead of silently accepting',
    `verification=${describeVerification(bug)}`,
  );
}

// ---------------------------------------------------------------- arm 4
arm('state-only');
{
  const bug = { id: 'KO-T4', state: 'verified', verified: false };
  ok(isVerifiedClaim(bug) === false, 'verified:false makes no claim');
  ok(carriesArtifactBinding(bug) === true, 'state verified still carries a binding');
  ok(diverges(bug) === true, 'the other direction of the hole is refused too');
}

console.log(lines.join('\n'));
console.log(`\nARMS ${lines.filter((l) => l.startsWith('  arm')).length}/4 present`);
console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} ledger-invariant checks=${checks} failed=${failed}`);
if (failed) process.exitCode = 1;
