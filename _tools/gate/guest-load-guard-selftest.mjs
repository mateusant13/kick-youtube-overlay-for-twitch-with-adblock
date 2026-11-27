#!/usr/bin/env node
// ARMS FOR THE GUEST LOAD GUARD: the launcher must refuse to start on a busy box.
//
// MEASURED 2026-11-27: `ko-load-check` printed BUSY and `ko-guest.mjs` started a guest
// anyway, because nothing read the verdict but the operator's eyes; the watcher then
// billed the tree (`chrome.exe(53020)`, 18 processes, 11.9 % of the machine) and sent a
// relief request. Prose in AGENTS.md did not stop it and will not stop it next time, so
// the refusal lives in the launcher and these arms keep it there.
//
// Every arm runs with `--dry-run` or a refusal, so NOTHING is launched: the whole selftest
// is <5 s and cannot itself become the heavy step.
//
//   1. BUSY            -> refuses, exit 3, reason carries total/busiest/pinned
//   2. BUSY + override -> proceeds (dry-run) and still reports the BUSY reading
//   3. READY           -> proceeds, no refusal
//   4. a `--flag` is never taken as the URL
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GUEST = path.join(ROOT, '_tools', 'ko-guest.mjs');

let checks = 0;
let failed = 0;
const lines = [];
// COUNTED, NEVER DECLARED. A literal `arms=4/4` is a claim the file makes about
// itself; delete a block and it still prints 4/4 while the gate's regex matches
// that same literal, so a suite missing a quarter of its coverage read whole.
const ARMS = [];
function arm(name) {
  ARMS.push(name);
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

function run(env, args = ['start', '--dry-run']) {
  const r = spawnSync(process.execPath, [GUEST, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    killSignal: 'SIGKILL',
    env: { ...process.env, ...env },
  });
  return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// 1. BUSY refuses before anything exists.
{
  arm('1-busy');
  const r = run({ KO_LOAD_FIXTURE: 'busy' }, ['start']);
  let j = null;
  try { j = JSON.parse(r.out.trim()); } catch { /* asserted below */ }
  ok(r.rc === 3, 'busy: exit 3 (refusal is not a crash)', `rc=${r.rc}`);
  ok(j !== null && j.refused === true, 'busy: refused true');
  ok(j !== null && /guest not started: BUSY /.test(String(j.reason)), 'busy: reason carries the reading', j && j.reason);
  // NAMES THE BREACH. The fixture puts every core at 100 % and the total at 100 %,
  // so both ceilings broke and the sentence must say both - the defect this replaced
  // was `total=57.2% (ceilings total 70%)`, refused for its CORE ceiling, which read
  // as a contradiction (seat DM dm-486c70525fc807e40aab).
  ok(j !== null && /total 100% above its 70% ceiling/.test(String(j.reason)), 'busy: reason names the total ceiling it broke', j && j.reason);
  // HOST-DERIVED, not a measured-box literal. The fixture pins EVERY core of
  // whatever host runs this (`load-sample.mjs:44` uses `os.cpus().length`), so a
  // hardcoded `/20 core/` made the arm green only on the 20-core box it was
  // written on and red everywhere else - a test of the machine, not the guard.
  ok(j !== null && /\b\d+ core\(s\) above 90%/.test(String(j.reason)), 'busy: reason names the core ceiling it broke', j && j.reason);
  ok(j !== null && String(j.reason).includes(`${cpus().length} core(s) above 90%`), 'busy: the pinned-core count equals this host\'s core count (not a literal)', j && j.reason);
  ok(j !== null && String(j.advice).includes('KO_ALLOW_BUSY=1'), 'busy: names the override');
}

// 2. The override exists and is loud.
{
  arm('2-override');
  const r = run({ KO_LOAD_FIXTURE: 'busy', KO_ALLOW_BUSY: '1' });
  let j = null;
  try { j = JSON.parse(r.out.trim()); } catch { /* asserted below */ }
  ok(r.rc === 0, 'override: exit 0', `rc=${r.rc}`);
  ok(j !== null && j.dryRun === true, 'override: reaches the launch (dry-run)');
  ok(j !== null && j.load.verdict === 'BUSY', 'override: still reports the BUSY reading it overrode');
}

// 3. READY is not refused.
{
  arm('3-ready');
  const r = run({ KO_LOAD_FIXTURE: 'ready' });
  let j = null;
  try { j = JSON.parse(r.out.trim()); } catch { /* asserted below */ }
  ok(r.rc === 0, 'ready: exit 0', `rc=${r.rc}`);
  ok(j !== null && j.dryRun === true && j.load.verdict === 'READY', 'ready: launches');
  ok(!/refused/.test(r.out), 'ready: no refusal text');
}

// 4. `start --dry-run` must not read the flag as the URL.
{
  arm('4-flag');
  const r = run({ KO_LOAD_FIXTURE: 'ready' });
  let j = null;
  try { j = JSON.parse(r.out.trim()); } catch { /* asserted below */ }
  ok(j !== null && !String(j.wouldStart.url).startsWith('--'), 'flag: the URL is not a --flag', j && j.wouldStart.url);
  ok(j !== null && j.wouldStart.port === '9446', 'flag: default port stays 9446 (never 9333, the relay)');
}

const EXPECTED_ARMS = 4;
const told = ARMS.length;
const allOk = failed === 0 && told === EXPECTED_ARMS;
for (const l of lines) console.log(l);
if (told !== EXPECTED_ARMS) console.error(`ARMS never entered: expected ${EXPECTED_ARMS}, entered ${told} (${ARMS.join(', ')})`);
console.log(`RESULT ${allOk ? 'PASS' : 'FAIL'} guest-load-guard checks=${checks} failed=${failed} arms=${told}/${EXPECTED_ARMS}`);
process.exit(allOk ? 0 : 1);
