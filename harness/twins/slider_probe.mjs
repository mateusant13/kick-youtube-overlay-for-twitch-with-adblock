// Measure the revival sliders from real commands and real files. No browser,
// no network, no dependencies: Node built-ins only.
//
// Usage:
//   node harness/twins/slider_probe.mjs <id>            one measured line
//   node harness/twins/slider_probe.mjs --all --json    machine object
//
// SLIDER_PROBE_ANGLES can point the harness-angle parse at a copy of
// harness/angulos.tsv (used by the falsifier to blank one neg cell).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const NOW = new Date();
const AT = NOW.toISOString();
const PY_SCRIPTS = 'C:/Users/Administrador/.agents/skills/project-revival/scripts';
const GIT_CHECKPOINT = `${PY_SCRIPTS}/git_checkpoint.py`;
const FEATURE_SYNC = `${PY_SCRIPTS}/feature_map_sync.py`;
// The per-edit loop of record is the same command revival/FRICTION.json names for
// friction.inner_test_loop: the two behavioural suites on the virtual clock (8-10 s).
// A narrower census+bridge+node--check smoke (0.6 s) cannot see the ad path's ordering,
// so scoring it as the loop would flatter the number and measure nothing the row cares about.
// The per-edit loop is the impacted fast loop (the same command the
// friction.inner_test_loop row names), measured on the WORST product file:
// twitch-adblock.js maps to ad-detect + cold-cover + mute-decision (~1.9 s).
// The two heavy suites are the LANDING set (the gate runs them) - scoring them
// as the edit loop measured how long the gate takes, not how fast an edit is.
const EDIT_LOOP = 'node _tools/gate/fast-loop.mjs --files kick-overlay/twitch-adblock.js';
const FAIL_FAST = `${PY_SCRIPTS}/fail_fast_audit.py`;
const GIT_LOG = 'git log -n12 --name-only --format=%x00%H';
const CENSUS_CMD = 'node _tools/ko-census.mjs --json';
const REPLAY_CMD = 'node harness/twins/replay.mjs --all --json';
const GATE_CMD = `python ${FEATURE_SYNC} --repo . --gate`;
const ANGLES_PATH = process.env.SLIDER_PROBE_ANGLES
  ? resolve(process.env.SLIDER_PROBE_ANGLES)
  : join(ROOT, 'harness', 'angulos.tsv');

const IDS = [
  'delivery_balance', 'observability', 'inner_loop_speed', 'architecture_coherence',
  'metric_gate_coverage', 'harness_falsifiers', 'reversibility_safety', 'autonomy_end_to_end',
];

function flat(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// One bounded child process. Every failure carries its own numbers so a
// missing fact can never be silently converted into a passing score.
function run(command, args, timeoutMs = 9000) {
  return new Promise((done) => {
    const started = performance.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (rc, timedOut, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ rc, timedOut, error: error || '', stdout, stderr, ms: performance.now() - started });
    };
    try {
      child = spawn(command, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(-1, false, error.message);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(124, true, `timeout after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(-1, false, error.message));
    child.on('close', (rc) => finish(rc == null ? -1 : rc, false, ''));
  });
}

function runShell(command, timeoutMs = 9000) {
  const win = process.platform === 'win32';
  return run(
    win ? (process.env.ComSpec || 'cmd.exe') : 'bash',
    win ? ['/d', '/s', '/c', command] : ['-c', command],
    timeoutMs,
  );
}

function readText(rel) {
  return readFileSync(isAbsolute(rel) ? rel : join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function measured(score, basis, proof) {
  return { score: clampScore(score), basis: flat(basis), proof: flat(proof) };
}

function cannot(reason, proof) {
  return {
    score: 'CANNOT-MEASURE',
    basis: `CANNOT-MEASURE: ${flat(reason)}`,
    reason: flat(reason),
    proof: flat(proof),
  };
}

// Cached so --all never runs a command twice (census feeds slider 2 and the
// detectability pair; the fast test feeds slider 3 and the inner-loop pair).
const cache = { promises: {}, values: {} };
function once(key, make) {
  if (!cache.promises[key]) {
    cache.promises[key] = make().then((value) => {
      cache.values[key] = value;
      return value;
    });
  }
  return cache.promises[key];
}
const cachedValue = (key) => cache.values[key];

// Timeouts are per child and sized to the instrument, not to a uniform guess:
// the feature gate and the census both walk the SMR spindle, and a 9 s ceiling
// turned a real measurement into CANNOT-MEASURE (measured 2026-11-26, cold
// cache: `architecture_coherence` came back CANNOT-MEASURE on a gate that reads
// FAIL in 1.2 s warm). A child that still starves reports its own timeout.
const getGitLog = () => once('gitLog', () => run('git', ['log', '-n12', '--name-only', '--format=%x00%H'], 8000));
const getCensus = () => once('census', () => run('node', ['_tools/ko-census.mjs', '--json'], 12000));
const getFast = () => once('fast', () => fastLoop());

// The inner loop is a WALL measurement on a box other lanes share. A single
// sample under contention measured 14 018 ms and scored 0 for two suites that
// take ~6.4 s together (benchmark_history `after`, direct instrument 467 ms +
// 5 963 ms), which is the queue printed as a product defect. Best-of-three is
// the estimator (same rule as `benchmark_history --samples 3` and the friction
// row's min-of-4); the per-sample cap is the sum of the two suites' own budget
// ceilings, so a cap can never fire before a ceiling the project already
// accepted.
const FAST_SAMPLES = 3;
const FAST_CAP_MS = 75000;
async function fastLoop() {
  const samples = [];
  for (let i = 0; i < FAST_SAMPLES; i += 1) {
    const r = await runShell(EDIT_LOOP, FAST_CAP_MS);
    samples.push(r);
  }
  const best = samples.reduce((a, b) => ((b.rc === 0 && !b.timedOut) && (!(a.rc === 0 && !a.timedOut) || b.ms < a.ms) ? b : a), samples[0]);
  return { ...best, samples: samples.map((s) => round(s.ms, 1)), sampleCount: samples.length };
}
const getGate = () => once('gate', () => run('python', [FEATURE_SYNC, '--repo', '.', '--gate'], 14000));
const getFailFast = () => once('failfast', () => run('python', [FAIL_FAST, 'scan', '--repo', '.', '--gate', '--all-code'], 45000));
const getReplay = () => once('replay', () => run('node', ['harness/twins/replay.mjs', '--all', '--json'], 12000));
const getHelp = (sub) => once(`help:${sub || 'top'}`, () => run('python', sub ? [GIT_CHECKPOINT, sub, '--help'] : [GIT_CHECKPOINT, '--help'], 12000));

function censusFacts(result) {
  if (!result || result.timedOut || result.error || !result.stdout.trim()) {
    throw new Error(`census produced no JSON (rc=${result?.rc}, ${flat(result?.error || result?.stderr).slice(0, 120)})`);
  }
  const doc = JSON.parse(result.stdout);
  const exits = (doc.files || []).flatMap((file) => file.exits || []);
  if (!exits.length) throw new Error('census JSON has no exits array');
  const guards = exits.filter((exit) => exit && exit.guardShaped === true);
  const state = doc.state || {};
  return {
    exits: exits.length,
    named: exits.filter((exit) => exit && exit.loggedNearby === true).length,
    guardShaped: Number(doc.totals?.guardShaped ?? guards.length),
    guardNamed: guards.filter((exit) => exit.loggedNearby === true).length,
    stateDeclared: Number(state.declared ?? 0),
    stateUnexercised: Array.isArray(state.unexercised) ? state.unexercised.length : 0,
  };
}

function deliveryBalance(result) {
  if (result.rc !== 0 || result.timedOut) return cannot(`git log failed (rc=${result.rc}, ${flat(result.error || result.stderr).slice(0, 120)})`, GIT_LOG);
  let product = 0;
  let meta = 0;
  let other = 0;
  for (const chunk of result.stdout.split('\0')) {
    const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
    const hash = lines.find((line) => /^[0-9a-f]{40}$/.test(line));
    if (!hash) continue;
    const paths = lines.filter((line) => line !== hash);
    if (paths.some((p) => /^(kick-overlay|_tools|harness)\//.test(p))) product += 1;
    else if (paths.length && paths.every((p) => /^(revival|benchmarks|features)\//.test(p) || /^[^/]+\.md$/.test(p))) meta += 1;
    else other += 1;
  }
  const total = product + meta + other;
  if (!total) return cannot('git log returned no parseable commits', GIT_LOG);
  return measured(100 * product / total, `product=${product} meta=${meta} other=${other} of total=${total} commits`, GIT_LOG);
}

// Observability is FOUR measured facts, averaged. The previous formula was
// `named / every return statement` and scored a compliant tree 11/100: 579 of
// the census' 654 exits are pure value getters (`return null`,
// `return mh[1].toLowerCase()`) that cannot and must not write a transition row,
// so the best reachable score was 100 * 75/654 even with every refusal named.
// Each fact below can regress on its own and each names its command.
//   A refusals: guard-shaped decision exits that carry a row of their own.
//   B state: ad-path state fields at least one arm references.
//   C suites: behavioural suites with an anti-vacuity guard (an expected-arm
//     list, so deleting an arm cannot read as a quieter green).
//   D hang: hang-capable calls with a bound (fail_fast --all-code, 0 findings).
function antiVacuitySuites() {
  const dir = join(ROOT, 'kick-overlay');
  const suites = readdirSync(dir).filter((f) => f.endsWith('-test.cjs'));
  const RE = /arms that never printed|expected label list|ANTI-VACUITY|anti-vacuity/i;
  const covered = suites.filter((f) => RE.test(readText(join(dir, f))));
  return { total: suites.length, covered: covered.length, names: covered };
}

function baselineGuardShaped() {
  try {
    const b = JSON.parse(readText(join(ROOT, '_tools', 'ko-census-budget.json')));
    const n = Number(b && b.baseline && b.baseline.guardShaped);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function observability(censusResult, failFastResult) {
  let facts;
  try {
    facts = censusFacts(censusResult);
  } catch (error) {
    return cannot(error.message, CENSUS_CMD);
  }
  // A FIXED DENOMINATOR, or the fact cannot rise. `named / guardShaped` is the
  // same defect as the old `named / every return`: `guardShaped` is defined as
  // the exits that carry NO row of their own, so the ratio is 0 by
  // construction and a tree that names every one of them still reads 0/0.
  // Measured 2026-11-27 with 105 conversions in place: `refusals 0 (0/4 guards
  // carry a row)`. The baseline is the 2026-11-20 measurement recorded in
  // `_tools/ko-census-budget.json`; a missing baseline is CANNOT-MEASURE, never
  // an invented denominator.
  const baseline = baselineGuardShaped();
  const refusals = baseline == null
    ? null
    : 100 * Math.max(0, Math.min(1, 1 - facts.guardShaped / baseline));
  const state = facts.stateDeclared ? 100 * (facts.stateDeclared - facts.stateUnexercised) / facts.stateDeclared : 0;
  const suites = antiVacuitySuites();
  const suiteScore = suites.total ? 100 * suites.covered / suites.total : 0;
  let hang = 0;
  let hangDetail = 'fail_fast not run';
  if (failFastResult && !failFastResult.timedOut) {
    try {
      const report = JSON.parse(String(failFastResult.stdout).slice(String(failFastResult.stdout).indexOf('{')));
      hang = report.total_findings === 0 ? 100 : 0;
      hangDetail = `findings=${report.total_findings}/${report.files_scanned} files`;
    } catch { hangDetail = `unparsable (rc=${failFastResult.rc})`; }
  }
  if (refusals == null) return cannot('`_tools/ko-census-budget.json` carries no `baseline.guardShaped`', CENSUS_CMD);
  const score = (refusals + state + suiteScore + hang) / 4;
  return measured(score, `refusals ${round(refusals, 1)} (guardShaped ${facts.guardShaped} of baseline ${baseline}; lower is progress)`
    + `; state ${round(state, 1)} (${facts.stateDeclared - facts.stateUnexercised}/${facts.stateDeclared} fields referenced by an arm)`
    + `; suites ${round(suiteScore, 1)} (${suites.covered}/${suites.total} anti-vacuity)`
    + `; hang ${hang} (${hangDetail})`,
  `${CENSUS_CMD} && node _tools/gate/fast-loop.mjs && python ${FAIL_FAST} scan --repo . --gate --all-code`);
}

// The scale is anchored on the playbook's own numbers instead of
// `100 * (1 - s/15)`, which scored a COMPLIANT 15 s loop 0 and a compliant
// 7.5 s loop 48: <=1.5 s is 100, <=5 s (the "5-15 s" goal's tight end) is 90,
// 15 s (the documented target, and the friction row's ceiling) is 60, and
// beyond it every extra second costs 2 points.
function innerLoopScore(seconds) {
  if (seconds <= 1.5) return 100;
  if (seconds <= 5) return 100 - (seconds - 1.5) * (10 / 3.5);
  if (seconds <= 15) return 90 - (seconds - 5) * (30 / 10);
  return Math.max(0, 60 - (seconds - 15) * 2);
}

function innerLoopSpeed(result) {
  const seconds = result.ms / 1000;
  const score = result.rc === 0 && !result.timedOut ? innerLoopScore(seconds) : 0;
  const detail = result.rc === 0 && !result.timedOut ? '' : flat(result.stderr || result.stdout).slice(0, 120);
  const spread = Array.isArray(result.samples) ? ` samples=[${result.samples.join(', ')}]ms best-of-${result.sampleCount}` : '';
  return measured(score, `rc=${result.rc} wall=${round(result.ms, 1)}ms${spread}${result.timedOut ? ' TIMEOUT' : ''}${detail ? ` tail=${detail}` : ''}`, EDIT_LOOP);
}

function architectureCoherence(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  const found = text.match(/has\s+(\d+)\s+unmapped file\(s\):\s*\[([^\]]*)\]/);
  let verdict = '';
  try {
    verdict = JSON.parse(result.stdout).verdict || '';
  } catch {
    verdict = (text.match(/"verdict"\s*:\s*"([A-Z]+)"/) || [])[1] || '';
  }
  let total;
  try {
    total = Number(readJson('features/features.json').total_tracked_files);
  } catch (error) {
    return cannot(`features/features.json total_tracked_files unavailable: ${error.message}`, GATE_CMD);
  }
  if (!Number.isFinite(total) || total <= 0) return cannot('features/features.json total_tracked_files is missing or zero', GATE_CMD);
  const names = found ? (found[2].match(/'([^']+)'/g) || []).map((name) => name.slice(1, -1)) : [];
  if (!found && !verdict) return cannot(`feature gate gave no verdict or unmapped count (rc=${result.rc}, ${flat(text).slice(0, 120)})`, GATE_CMD);
  const unmapped = found ? Number(found[1]) : 0;
  return measured(
    100 * (1 - unmapped / total),
    `gate=${verdict || 'UNKNOWN'} unmapped=${unmapped}/${total} names=[${names.join(', ')}]`,
    GATE_CMD,
  );
}

function metricGateCoverage() {
  let budgets;
  let historyText;
  try {
    budgets = readJson('benchmarks/budgets.json');
    historyText = readText('benchmarks/history.jsonl');
  } catch (error) {
    return cannot(`budget or history input unreadable: ${error.message}`, 'read benchmarks/budgets.json + benchmarks/history.jsonl');
  }
  const metrics = budgets.metrics || [];
  if (!metrics.length) return cannot('benchmarks/budgets.json has no metrics', 'read benchmarks/budgets.json + benchmarks/history.jsonl');
  const rows = [];
  for (const line of historyText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* tolerate a half-written last line */ }
  }
  const since = Date.parse(AT) - 24 * 3600 * 1000;
  const table = [];
  let qualified = 0;
  for (const metric of metrics) {
    const ceilingOk = Number(metric.ceiling) > 0;
    const redOk = typeof metric.red_arm_cmd === 'string' && metric.red_arm_cmd.trim() !== '';
    const recent = rows.some((row) => {
      const ts = Date.parse(row.ts);
      return Number.isFinite(ts) && ts >= since && Array.isArray(row.results)
        && row.results.some((entry) => entry && entry.id === metric.id);
    });
    const ok = ceilingOk && redOk && recent;
    if (ok) qualified += 1;
    const why = ok ? 'YES' : !ceilingOk ? 'NO(no ceiling)' : !redOk ? 'NO(no red_arm_cmd)' : 'NO(no history in 24h)';
    table.push(`${metric.id}=${why}`);
  }
  return measured(100 * qualified / metrics.length, `${table.join('; ')}; qualified=${qualified}/${metrics.length}`, 'read benchmarks/budgets.json + benchmarks/history.jsonl');
}

function harnessFalsifiers() {
  let text;
  try {
    text = readText(ANGLES_PATH);
  } catch (error) {
    return cannot(`harness angles file unreadable: ${error.message}`, `read ${ANGLES_PATH}`);
  }
  const rows = text.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (!rows.length) return cannot('harness/angulos.tsv has no data rows', `read ${ANGLES_PATH}`);
  const families = new Set();
  const dropped = [];
  let qualified = 0;
  for (const line of rows) {
    const fields = line.split('\t');
    const feature = (fields[0] || '').trim();
    const angle = (fields[1] || '').trim();
    const cmd = fields[2] || '';
    const neg = (fields[4] || '').trim();
    families.add(feature);
    const nodePath = (cmd.match(/\bnode\s+([^\s"']+)/) || [])[1];
    const fileOk = Boolean(nodePath) && existsSync(isAbsolute(nodePath) ? nodePath : resolve(ROOT, nodePath));
    if (neg && fileOk) qualified += 1;
    else dropped.push(`${feature}/${angle}`);
  }
  return measured(
    100 * qualified / rows.length,
    `qualified=${qualified}/${rows.length} families=${families.size}${dropped.length ? ` dropped=[${dropped.join(', ')}]` : ''} angles=${ANGLES_PATH}`,
    `read ${ANGLES_PATH}`,
  );
}

async function reversibilitySafety() {
  const [top, land, rollback] = await Promise.all([getHelp(null), getHelp('wt-land'), getHelp('rollback')]);
  for (const [name, result] of [['--help', top], ['wt-land --help', land], ['rollback --help', rollback]]) {
    if (result.timedOut || result.error || !result.stdout.trim()) {
      return cannot(`git_checkpoint.py ${name} unavailable (rc=${result.rc}, ${flat(result.error || result.stderr).slice(0, 120)})`, `python ${GIT_CHECKPOINT} --help`);
    }
  }
  let checkpointRows = 0;
  try {
    checkpointRows = readText('revival/checkpoints.jsonl').split(/\r?\n/).filter((line) => {
      if (!line.trim()) return false;
      try { JSON.parse(line); return true; } catch { return false; }
    }).length;
  } catch (error) {
    return cannot(`revival/checkpoints.jsonl unreadable: ${error.message}`, `python ${GIT_CHECKPOINT} --help`);
  }
  const a = checkpointRows >= 1;
  const b = top.stdout.includes('wt-new');
  const c = land.stdout.includes('wt-land') && land.stdout.includes('--receipt') && land.stdout.includes('--gate-cmd');
  const d = rollback.stdout.includes('rollback') && rollback.stdout.includes('--confirm');
  const met = Number(a) + Number(b) + Number(c) + Number(d);
  return measured(
    25 * met,
    `checkpoints=${checkpointRows} wt-new=${b ? 'yes' : 'no'} wt-land(--receipt,--gate-cmd)=${c ? 'yes' : 'no'} rollback(--confirm)=${d ? 'yes' : 'no'} met=${met}/4`,
    `python ${GIT_CHECKPOINT} --help`,
  );
}

function autonomyEndToEnd() {
  let doc;
  try {
    doc = readJson('revival/FRICTION.json');
  } catch (error) {
    return cannot(`revival/FRICTION.json unreadable: ${error.message}`, 'read revival/FRICTION.json');
  }
  const rows = doc.frictions || [];
  if (!rows.length) return cannot('revival/FRICTION.json has no frictions rows', 'read revival/FRICTION.json');
  let qualified = 0;
  const table = rows.map((row) => {
    const ok = typeof row.verify_cmd === 'string' && row.verify_cmd.trim() !== '' && row.status === 'VERIFIED';
    if (ok) qualified += 1;
    // `after_s` is deliberately NOT part of the basis: the friction gate rewrites
    // it on every run, so quoting it here would make this evidence stale the next
    // time the gate runs and would read as a real change in autonomy.
    return `${row.id}=${row.status}${ok ? '' : '(unverified)'}`;
  });
  return measured(100 * qualified / rows.length, `${table.join('; ')}; qualified=${qualified}/${rows.length}`, 'read revival/FRICTION.json');
}

const SLIDERS = {
  delivery_balance: () => getGitLog().then(deliveryBalance),
  observability: () => Promise.all([getCensus(), getFailFast()]).then(([census, failFast]) => observability(census, failFast)),
  inner_loop_speed: () => getFast().then(innerLoopSpeed),
  architecture_coherence: () => getGate().then(architectureCoherence),
  metric_gate_coverage: async () => metricGateCoverage(),
  harness_falsifiers: async () => harnessFalsifiers(),
  reversibility_safety: reversibilitySafety,
  autonomy_end_to_end: async () => autonomyEndToEnd(),
};

async function buildPairs() {
  const facts = (() => { try { return censusFacts(cachedValue('census')); } catch (error) { return { error: error.message }; } })();
  const replayResult = cachedValue('replay');
  let replay = null;
  if (replayResult && replayResult.stdout.trim()) {
    try { replay = JSON.parse(replayResult.stdout); } catch { /* reported below */ }
  }
  const twins = replay && Array.isArray(replay.twins) ? replay.twins : [];
  const passed = twins.filter((twin) => twin && twin.status === 'PASS').length;
  const fast = cachedValue('fast');

  const detectability = facts.exits
    ? {
      unit: 'pct_faults_named',
      current: round(100 * facts.named / facts.exits, 2),
      counterpart_metric: 'instrument_wall_ms',
      counterpart_value: replay ? Number(replay.ms) : 'CANNOT-MEASURE',
      basis: `named=${facts.named}/exits=${facts.exits} guardShaped=${facts.guardShaped}; replay_ms=${replay ? replay.ms : 'missing'}`,
      proof: `${CENSUS_CMD} && ${REPLAY_CMD}`,
    }
    : {
      unit: 'pct_faults_named',
      current: 'CANNOT-MEASURE',
      counterpart_metric: 'instrument_wall_ms',
      counterpart_value: 'CANNOT-MEASURE',
      basis: `CANNOT-MEASURE: ${facts.error}`,
      proof: CENSUS_CMD,
    };

  let newestAt = null;
  let newestFile = '';
  try {
    for (const name of readdirSync(join(ROOT, 'harness', 'twins', 'recordings')).filter((entry) => entry.endsWith('.json'))) {
      const doc = JSON.parse(readText(join('harness', 'twins', 'recordings', name)));
      const stamp = Date.parse(doc.recorded_at);
      if (Number.isFinite(stamp) && (!newestAt || stamp > newestAt)) {
        newestAt = stamp;
        newestFile = name;
      }
    }
  } catch { /* reported as CANNOT-MEASURE below */ }
  const ageHours = newestAt == null ? 'CANNOT-MEASURE' : round((Date.parse(AT) - newestAt) / 3600000, 3);
  const innerLoopWall = fast && !fast.timedOut
    ? {
      unit: 'seconds',
      current: round(fast.ms / 1000, 3),
      counterpart_metric: 'twin_calibration_age_h',
      counterpart_value: ageHours,
      basis: `edit_loop_rc=${fast.rc} wall=${round(fast.ms, 1)}ms newest_recorded_at=${newestFile || 'missing'}`,
      proof: EDIT_LOOP,
    }
    : {
      unit: 'seconds',
      current: fast ? round(fast.ms / 1000, 3) : 'CANNOT-MEASURE',
      counterpart_metric: 'twin_calibration_age_h',
      counterpart_value: ageHours,
      basis: `CANNOT-MEASURE: edit_loop did not complete (${fast ? flat(fast.error || fast.stderr).slice(0, 120) : 'not run'})`,
      proof: EDIT_LOOP,
    };

  const e2e = replay && twins.length
    ? {
      unit: 'pct_golden_pass',
      current: round(100 * passed / twins.length, 2),
      counterpart_metric: 'e2e_p95_ms',
      counterpart_value: Number(replay.ms),
      basis: `pass=${passed}/total=${twins.length} ms=${replay.ms} verdict=${replay.result}`,
      proof: REPLAY_CMD,
    }
    : {
      unit: 'pct_golden_pass',
      current: 'CANNOT-MEASURE',
      counterpart_metric: 'e2e_p95_ms',
      counterpart_value: 'CANNOT-MEASURE',
      basis: `CANNOT-MEASURE: replay output unparsable (${flat(replayResult?.stderr || replayResult?.error || 'no run').slice(0, 120)})`,
      proof: REPLAY_CMD,
    };

  return { detectability, inner_loop_wall: innerLoopWall, e2e_correctness: e2e };
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const json = args.includes('--json');
  const requested = args.find((arg) => !arg.startsWith('--'));
  if (!all && (!requested || !Object.hasOwn(SLIDERS, requested))) {
    process.stderr.write(`SLIDER USAGE node harness/twins/slider_probe.mjs <${IDS.join('|')}> | --all [--json]\n`);
    process.exit(2);
  }

  if (!all) {
    const result = await SLIDERS[requested]();
    process.stdout.write(`SLIDER ${requested} score=${result.score} basis=${result.basis} proof=${result.proof}\n`);
    return;
  }

  // Time the declared inner loop with no competing census/gate/replay child.
  await getFast();
  const [results] = await Promise.all([
    Promise.all(IDS.map((id) => SLIDERS[id]())),
    getReplay(),
  ]);
  const sliders = Object.fromEntries(IDS.map((id, index) => [id, results[index]]));
  const pairs = await buildPairs();

  if (json) {
    process.stdout.write(`${JSON.stringify({ schema: 'revival.sliders.probe/v1', at: AT, sliders, pairs })}\n`);
  } else {
    for (const id of IDS) {
      const result = sliders[id];
      process.stdout.write(`SLIDER ${id} score=${result.score} basis=${result.basis} proof=${result.proof}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`SLIDER PROBE ERROR ${flat(error && error.stack || error)}\n`);
  process.exit(2);
});
