#!/usr/bin/env node
// ARMS FOR THE TIMING WRAPPER: a suite's wall time is graded only on a box that could run it.
//
// Four arms, each printing what it sees; the verdict line is `RESULT PASS timed-suite
// checks=N failed=0 arms=4/4`.
//
//   1. BUSY     -> a typed refusal (`latency_refused: true`), rc 0, and NO number anywhere
//   2. CANNOT   -> a typed refusal naming the missing reading, rc 0
//   3. READY    -> `RESULT_MS=<digits>` and rc 0 from a trivial suite
//   4. FAILING  -> the suite's own rc is propagated (a red suite is never a refusal)
//
// Plus the MUTANT arm the other four exist for: raise the ceilings to 100 % and the same
// BUSY fixture MEASURES instead of refusing - so arm 1 can fail the other way, and a
// wrapper that ignored the load would be caught rather than trusted.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WRAPPER = path.join(ROOT, '_tools', 'ko-timed-suite.mjs');

let checks = 0;
let failed = 0;
const arms = [];
// COUNTED, NEVER DECLARED. A literal `arms=4/4` in the verdict is a claim the
// file makes about itself: delete an arm block and it still printed 4/4 while
// the gate's own regex matched that same literal, so a suite that lost a third
// of its coverage read exactly like a whole one. Each block declares itself
// here and the verdict prints what was actually entered (heavy-lock pattern).
const ARMS = [];
function arm(name) {
  ARMS.push(name);
  arms.push(`  arm  ${name}`);
}
function ok(cond, label, detail = '') {
  checks += 1;
  if (cond) {
    arms.push(`  ok   ${label}`);
  } else {
    failed += 1;
    arms.push(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function run(env, args = []) {
  const r = spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    killSignal: 'SIGKILL',
    env: { ...process.env, ...env },
  });
  return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// 1. BUSY refuses, with the numbers in the reason and no measurement in the receipt.
{
  arm('1-busy');
  const r = run({ KO_LOAD_FIXTURE: 'busy' });
  let j = null;
  try { j = JSON.parse(r.out.trim()); } catch { /* asserted below */ }
  ok(r.rc === 0, 'busy: exit 0 (a refusal is not an error)', `rc=${r.rc}`);
  ok(j !== null && j.latency_refused === true, 'busy: latency_refused true');
  ok(j !== null && /starved: total=\d+% busiest=\d+% pinned=\d+/.test(String(j.latency_refused_reason)), 'busy: reason carries total/busiest/pinned', j && j.latency_refused_reason);
  ok(!/RESULT_MS=/.test(r.out), 'busy: no wall time printed (a number here would be a queue sold as a measurement)');
}

// 2. CANNOT-MEASURE refuses too: a sampler that could not read is not a fast suite.
{
  arm('2-cannot');
  const r = run({ KO_LOAD_FIXTURE: 'cannot' });
  let j = null;
  try { j = JSON.parse(r.out.trim()); } catch { /* asserted below */ }
  ok(r.rc === 0, 'cannot: exit 0', `rc=${r.rc}`);
  ok(j !== null && j.latency_refused === true, 'cannot: latency_refused true');
  ok(j !== null && /no cpu reading/.test(String(j.latency_refused_reason)), 'cannot: reason names the missing reading');
}

// 3. READY measures.
{
  arm('3-ready');
  const r = run({ KO_LOAD_FIXTURE: 'ready' }, ['--suite', 'node -e "console.log(1)"', '--label', 'trivial']);
  ok(r.rc === 0, 'ready: exit 0', `rc=${r.rc}`);
  ok(/RESULT_MS=\d+/.test(r.out), 'ready: prints RESULT_MS=<digits>', r.out.slice(0, 120));
  ok(/RESULT PASS trivial ms=\d+ load_ready=1/.test(r.out), 'ready: prints its own verdict');
}

// 4. A failing suite is a FAIL, never a refusal.
{
  arm('4-failing');
  const r = run({ KO_LOAD_FIXTURE: 'ready' }, ['--suite', 'node -e "process.exit(7)"', '--label', 'fake']);
  ok(r.rc === 7, 'failing suite: rc propagated (7)', `rc=${r.rc}`);
  ok(/RESULT FAIL fake rc=7/.test(r.out), 'failing suite: prints RESULT FAIL with the rc');
}

// MUTANT: the same busy box with the ceilings removed must MEASURE, which is the defect
// arms 1-3 protect against. If this arm ever stops measuring, the refusal arms prove nothing.
{
  arm('5-mutant');
  const r = run({ KO_LOAD_FIXTURE: 'busy', KO_LOAD_MAX_TOTAL: '100', KO_LOAD_MAX_CORE: '100' }, ['--suite', 'node -e "console.log(1)"', '--label', 'mutant']);
  ok(/RESULT_MS=\d+/.test(r.out), 'MUTANT: ceilings raised, the busy box measures (so the refusal arms can fail the other way)', r.out.slice(0, 120));
  ok(!/latency_refused/.test(r.out), 'MUTANT: no refusal when the instrument was told nothing is busy');
}

const EXPECTED_ARMS = 5;
const told = ARMS.length;
const okAll = failed === 0 && told === EXPECTED_ARMS;
for (const line of arms) console.log(line);
if (told !== EXPECTED_ARMS) {
  console.error(`ARMS never entered: expected ${EXPECTED_ARMS}, entered ${told} (${ARMS.join(', ')})`);
}
console.log(`RESULT ${okAll ? 'PASS' : 'FAIL'} timed-suite checks=${checks} failed=${failed} arms=${told}/${EXPECTED_ARMS}`);
process.exit(okAll ? 0 : 1);
