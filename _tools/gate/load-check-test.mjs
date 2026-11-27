// Plain-node check of the load pre-flight: pure predicates plus the real CLI's
// single-JSON-line / exit-code / `&&` contract. No test framework, no gate.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { evaluateLoad, exitCodeFor } from './load-verdict.mjs';

const TOOL = fileURLToPath(new URL('../ko-load-check.mjs', import.meta.url));
const TOOL_SH = TOOL.replace(/\\/g, '/');
const NODE_SH = process.execPath.replace(/\\/g, '/');
const CEILINGS = { total: 70, core: 90, windowMs: 1500 };
const CHECKS = { total: 0, failed: 0 };

function check(what, ok, detail = '') {
  CHECKS.total += 1;
  if (!ok) {
    CHECKS.failed += 1;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}
function eq(what, actual, expected) {
  check(what, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// A 1000 ms window where `percent` of every core is busy.
function pair(percent) {
  const cores = 4;
  const idle = 1000 - percent * 10;
  return [
    Array.from({ length: cores }, () => ({ idle: 0, total: 1000 })),
    Array.from({ length: cores }, () => ({ idle, total: 2000 })),
  ];
}

function runTool(env, args = ['--json']) {
  const clean = { ...process.env };
  for (const key of ['KO_LOAD_FIXTURE', 'KO_LOAD_SAMPLE_MS', 'KO_LOAD_MAX_TOTAL', 'KO_LOAD_MAX_CORE']) {
    delete clean[key];
  }
  return spawnSync(process.execPath, [TOOL, ...args], { timeout: 60000, killSignal: 'SIGKILL',
    encoding: 'utf8', env: { ...clean, ...env }, cwd: os.tmpdir(), windowsHide: true,
  });
}

function runBash(fixture) {
  const command = `"${NODE_SH}" "${TOOL_SH}" --gate && echo LEFT-SIDE-RAN`;
  return spawnSync('bash', ['-c', command], { timeout: 60000, killSignal: 'SIGKILL',
    encoding: 'utf8',
    env: { ...process.env, KO_LOAD_FIXTURE: fixture, KO_LOAD_SAMPLE_MS: '50' },
    cwd: os.tmpdir(),
    windowsHide: true,
  });
}

// 1. Ready fixture: READY and exit 0 with and without a gate.
{
  const [before, after] = pair(0);
  const out = evaluateLoad(before, after, CEILINGS);
  eq('ready verdict', out.verdict, 'READY');
  eq('ready advice', out.advice, 'one heavy step at a time is allowed now (the gate is that step)');
  eq('ready total', out.total, 0);
  eq('ready exit with gate', exitCodeFor(out.verdict, { gate: true }), 0);
  eq('ready exit without gate', exitCodeFor(out.verdict), 0);
}

// 2. Busy fixture: BUSY, exit 2 with a gate, exit 0 without, QUEUE advice.
{
  const [before, after] = pair(100);
  const out = evaluateLoad(before, after, CEILINGS);
  eq('busy verdict', out.verdict, 'BUSY');
  eq('busy total', out.total, 100);
  eq('busy pinned', out.pinned, 4);
  check('busy advice has QUEUE', typeof out.advice === 'string' && out.advice.includes('QUEUE'), out.advice);
  eq('busy exit with gate', exitCodeFor(out.verdict, { gate: true }), 2);
  eq('busy exit without gate', exitCodeFor(out.verdict, { gate: false }), 0);
  eq('busy exit default', exitCodeFor(out.verdict), 0);
}

// 3. Dead counters: CANNOT-MEASURE and exit 3 with or without a gate.
{
  const before = Array.from({ length: 4 }, () => ({ idle: 5, total: 100 }));
  const after = before.map((s) => ({ ...s }));
  const out = evaluateLoad(before, after, CEILINGS);
  eq('dead verdict', out.verdict, 'CANNOT-MEASURE');
  eq('dead why', out.why, 'no cpu counter advanced in the window');
  eq('dead windowMs', out.windowMs, 1500);
  eq('dead exit with gate', exitCodeFor(out.verdict, { gate: true }), 3);
  eq('dead exit without gate', exitCodeFor(out.verdict), 3);
}

// 4. Ceilings: 71% is BUSY at 70 but READY at 90; the CLI maps its env var in.
{
  const [before, after] = pair(71);
  eq('reading is 71%', evaluateLoad(before, after, CEILINGS).total, 71);
  eq('71 is BUSY at ceiling 70', evaluateLoad(before, after, CEILINGS).verdict, 'BUSY');
  eq('71 is READY at ceiling 90', evaluateLoad(before, after, { ...CEILINGS, total: 90 }).verdict, 'READY');
  const raised = runTool({ KO_LOAD_FIXTURE: 'ready', KO_LOAD_MAX_TOTAL: '90' });
  let parsed = null;
  try { parsed = JSON.parse(raised.stdout.trim()); } catch { /* reported below */ }
  eq('CLI passes KO_LOAD_MAX_TOTAL=90', parsed && parsed.ceilings && parsed.ceilings.total, 90);
  eq('CLI exit with raised ceiling', raised.status, 0);
}

// 5. Real subprocess: one parsable JSON line, schema/types, and exit contract.
{
  const run = runTool({ KO_LOAD_SAMPLE_MS: '150' });
  const lines = run.stdout.trim().split(/\r?\n/);
  eq('real one output line', lines.length, 1);
  let out = null;
  try { out = JSON.parse(lines[0]); } catch { /* reported below */ }
  check('real JSON parsed', out !== null && typeof out === 'object');
  if (out) {
    check('real verdict known', ['READY', 'BUSY', 'CANNOT-MEASURE'].includes(out.verdict), String(out.verdict));
    if (out.verdict === 'CANNOT-MEASURE') {
      check('real CANNOT-MEASURE has why', typeof out.why === 'string' && out.why.length > 0, String(out.why));
    } else {
      const keys = ['advice', 'busiest', 'ceilings', 'cores', 'perCore', 'pinned', 'total', 'verdict', 'windowMs'];
      eq('real schema keys', JSON.stringify(Object.keys(out).sort()), JSON.stringify(keys));
      for (const key of ['windowMs', 'cores', 'total', 'busiest', 'pinned']) {
        check(`real ${key} is a number`, Number.isFinite(out[key]), JSON.stringify(out[key]));
      }
      check('real ceilings types', out.ceilings && Number.isFinite(out.ceilings.total) && Number.isFinite(out.ceilings.core), JSON.stringify(out.ceilings));
      check('real perCore numbers', Array.isArray(out.perCore) && out.perCore.length > 0 && out.perCore.every(Number.isFinite), JSON.stringify(out.perCore));
      eq('real cores matches perCore', out.cores, out.perCore.length);
      check('real advice is a string', typeof out.advice === 'string' && out.advice.length > 0, String(out.advice));
    }
    const expected = exitCodeFor(out.verdict, { gate: false });
    check('real exit code in contract', [0, 2, 3].includes(run.status), String(run.status));
    eq('real exit matches exitCodeFor', run.status, expected);
  }
}

// 6. `&&` contract, forced: BUSY stops the right side, READY allows it.
{
  const busy = runBash('busy');
  eq('busy && exit', busy.status, 2);
  check('busy && did not run right side', !busy.stdout.includes('LEFT-SIDE-RAN'), busy.stdout);
  const ready = runBash('ready');
  eq('ready && exit', ready.status, 0);
  check('ready && ran right side', ready.stdout.includes('LEFT-SIDE-RAN'), ready.stdout);
}

// 7. Bad fixture value: CANNOT-MEASURE with the exact reason, exit 3.
{
  const expected = JSON.stringify({ verdict: 'CANNOT-MEASURE', why: 'bad KO_LOAD_FIXTURE value' });
  const plain = runTool({ KO_LOAD_FIXTURE: 'nope' });
  eq('bad fixture exit', plain.status, 3);
  eq('bad fixture JSON', plain.stdout.trim(), expected);
  const gated = runTool({ KO_LOAD_FIXTURE: 'nope' }, ['--json', '--gate']);
  eq('bad fixture exit with gate', gated.status, 3);
  eq('bad fixture JSON with gate', gated.stdout.trim(), expected);
}

const result = CHECKS.failed === 0 ? 'PASS' : 'FAIL';
console.log(`RESULT ${result} load-check-json checks=${CHECKS.total} failed=${CHECKS.failed}`);
process.exit(CHECKS.failed === 0 ? 0 : 1);
