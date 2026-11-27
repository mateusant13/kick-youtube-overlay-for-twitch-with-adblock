#!/usr/bin/env node
// ARMS FOR THE GATE'S CRASH PATH.
//
// MEASURED 2026-11-27 (audit A3GateRevival): `prepareReceipt(ctx)` ran OUTSIDE
// `runCheck`, so a throw there — a missing `PRODUCT_JS` file read at
// `receipt.mjs`'s sha256 loop, or `writeArmArtifacts` — aborted before
// `finalizeReceipt`. JSON is written only by `finalizeReceipt`, so the PREVIOUS
// receipt stayed on disk: `result: "PASS"` beside a run that crashed, with a new
// exit code of 1 that nothing on disk corroborated. That is the one artifact a
// gate must never leave behind.
//
// Nothing tracked is mutated. Each arm builds a fake context with an evidence
// directory under `G:/Temp/ko-scratch`, so a crash-path write never touches
// `_evidence/`.
//
//   1. guard writes FAIL  -> crashReceipt writes JSON+md with result FAIL and a
//                            `gate-crashed` row, and sets exit code 1
//   2. RED: stale PASS    -> the PRE-FIX sequence (throw before finalize, no
//                            guard) leaves the previous PASS receipt on disk;
//                            this arm fails if that is not true, i.e. it proves
//                            the defect the guard exists to remove
//   3. normal path intact -> finalizeReceipt still writes PASS when no check
//                            failed (the guard did not leak into the happy path)
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { crashReceipt, finalizeReceipt } from './receipt.mjs';

const SCRATCH = 'G:/Temp/ko-scratch/crash-receipt-selftest';
let checks = 0;
let failed = 0;
const lines = [];

function ok(cond, label, detail = '') {
  checks += 1;
  if (cond) lines.push(`  ok   ${label}`);
  else {
    failed += 1;
    lines.push(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function arm(name) {
  lines.push(`  arm  ${name}`);
}

// crashReceipt and finalizeReceipt print their own RESULT lines; capture them so
// this selftest's stdout carries exactly one RESULT line for a gate check to read.
function quietly(fn) {
  const log = console.log;
  const err = console.error;
  const buf = [];
  console.log = (...a) => buf.push(a.join(' '));
  console.error = (...a) => buf.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return buf.join('\n');
}

function fakeCtx(dir) {
  mkdirSync(dir, { recursive: true });
  return {
    ROOT: dir,
    state: {
      results: [{ name: 'first-check', status: 'PASS', detail: '' }],
      started: Date.now() - 5,
      manifest: { version: '0.0.0-selftest' },
      ledger: { schema: 1, bugs: [] },
      armArtifacts: [],
      notMeasured: ['selftest placeholder'],
      unverified: [],
      livePending: [],
      gitHead: 'deadbee',
      evidenceDir: dir,
      payload: null,
    },
  };
}

const JSON_PATH = (dir) => path.join(dir, 'ko-verify-latest.json');
const MD_PATH = (dir) => path.join(dir, 'ko-verify-latest.md');

function reset() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
}

// ---------------------------------------------------------------- arm 1
arm('guard writes FAIL');
reset();
{
  const dir = path.join(SCRATCH, 'guard');
  const ctx = fakeCtx(dir);
  const printed = quietly(() => crashReceipt(ctx, new Error('boom: a PRODUCT_JS file was missing')));
  ok(/RESULT FAIL/.test(printed), 'crashReceipt printed RESULT FAIL on its own stream');
  ok(/FAIL gate-crashed/.test(printed), 'crashReceipt named the crash on stderr');
  const json = JSON.parse(readFileSync(JSON_PATH(dir), 'utf8'));
  const md = readFileSync(MD_PATH(dir), 'utf8');
  ok(json.result === 'FAIL', 'crashReceipt wrote result FAIL', `got ${json.result}`);
  ok(
    json.checks.some((c) => c.name === 'gate-crashed' && c.status === 'FAIL'),
    'crashReceipt recorded a gate-crashed FAIL row',
  );
  ok(/- result: \*\*FAIL\*\*/.test(md), 'the markdown receipt says FAIL');
  ok(process.exitCode === 1, 'crashReceipt set the process exit code to 1');
  process.exitCode = 0;
}

// ---------------------------------------------------------------- arm 2 (RED)
arm('RED: stale PASS without the guard');
reset();
{
  const dir = path.join(SCRATCH, 'red');
  const ctx = fakeCtx(dir);
  // A previous, healthy run left a PASS receipt on disk (exactly what the gate
  // writes today when it succeeds).
  ctx.state.payload = {
    schema: 1,
    generated_at: '2026-01-01T00:00:00.000Z',
    elapsed_ms: 1,
    git_head: 'oldhead',
    version: '0.0.0-previous',
    result: 'PASS',
    checks: ctx.state.results,
    source_sha256: {},
    bugs: [],
    not_measured: [],
    measured_live: [],
  };
  quietly(() => finalizeReceipt(ctx));
  const before = JSON.parse(readFileSync(JSON_PATH(dir), 'utf8'));
  ok(before.result === 'PASS', 'a healthy run leaves a PASS receipt (precondition)');

  // Now a LATER run throws before finalize and WITHOUT the guard: this is the
  // pre-fix sequence, reproduced exactly.
  let threw = false;
  try {
    // stands in for `prepareReceipt(ctx)` throwing outside runCheck
    throw new Error('boom: writeArmArtifacts failed');
  } catch {
    threw = true;
  }
  const after = JSON.parse(readFileSync(JSON_PATH(dir), 'utf8'));
  ok(threw, 'the pre-fix sequence threw before finalize (precondition)');
  ok(
    after.result === 'PASS' && after.git_head === 'oldhead',
    'RED: without the guard the stale PASS from the previous run stays on disk',
    `got result=${after.result} git_head=${after.git_head}`,
  );

  // The guard, applied to the same state, replaces that stale PASS.
  quietly(() => crashReceipt(ctx, new Error('boom: writeArmArtifacts failed')));
  const fixed = JSON.parse(readFileSync(JSON_PATH(dir), 'utf8'));
  ok(fixed.result === 'FAIL', 'with the guard the stale PASS is replaced by FAIL', `got ${fixed.result}`);
  process.exitCode = 0;
}

// ---------------------------------------------------------------- arm 3
arm('normal path intact');
reset();
{
  const dir = path.join(SCRATCH, 'happy');
  const ctx = fakeCtx(dir);
  ctx.state.payload = {
    schema: 1,
    generated_at: '2026-01-01T00:00:00.000Z',
    elapsed_ms: 2,
    git_head: 'beef123',
    version: '0.0.0-selftest',
    result: 'PASS',
    checks: ctx.state.results,
    source_sha256: {},
    bugs: [],
    not_measured: [],
    measured_live: [],
  };
  quietly(() => finalizeReceipt(ctx));
  const json = JSON.parse(readFileSync(JSON_PATH(dir), 'utf8'));
  ok(json.result === 'PASS', 'finalizeReceipt still writes PASS when no check failed', `got ${json.result}`);
  ok(json.checks.length === 1 && json.checks[0].name === 'first-check', 'the happy path keeps its check rows');
}

rmSync(SCRATCH, { recursive: true, force: true });

console.log(lines.join('\n'));
console.log(`\nARMS ${lines.filter((l) => l.startsWith('  arm')).length}/3 present`);
console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} crash-receipt checks=${checks} failed=${failed}`);
if (failed) process.exitCode = 1;
