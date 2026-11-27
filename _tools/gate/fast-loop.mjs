// The per-EDIT loop: the suites an edit can actually break, run now.
//
// The landing gate (`node _tools/ko-verify.mjs`) runs everything once; this
// runs the narrow set while the edit is still being made, which is the only
// way the inner loop fits in seconds. It is NOT a weaker gate: a file whose
// suite is missing from this map makes the loop FAIL (a silent skip would let
// an edit reach landing with nothing having looked at it).
//
//   node _tools/gate/fast-loop.mjs                       # the current diff vs HEAD
//   node _tools/gate/fast-loop.mjs --files a.js,b.js     # an explicit set
//   node _tools/gate/fast-loop.mjs --all                 # every suite (pre-landing)
//   node _tools/gate/fast-loop.mjs --json                # machine line for the probe
//
// Exit codes: 0 every impacted suite passed; 1 a suite failed or a changed
// product file has no suite mapping; 2 nothing was impacted (an explicit
// `--files` naming only documentation is a caller error, not a pass).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OVERLAY = path.join(ROOT, 'kick-overlay');

// One suite is enough to falsify each of these; the heavy landing suite
// (`ad-time-continuity-test.cjs`, 194 checks, ~7.5 s) is deliberately absent —
// it runs at landing, and pulling it into every edit is what made the loop
// 11 s long.
const SUITES = {
  'kick-overlay/content.js': ['content-fix-test.cjs'],
  'kick-overlay/twitch-adblock.js': ['ad-detect-test.cjs', 'cold-cover-fixture-test.cjs', 'mute-decision-test.cjs'],
  'kick-overlay/player-bridge.js': ['bridge-handshake-test.cjs'],
  'kick-overlay/ko-audio.js': ['mute-decision-test.cjs', 'tab-audio-scope-test.cjs'],
  'kick-overlay/adblock-bridge.js': ['mute-decision-test.cjs'],
  'kick-overlay/yt-route.js': ['yt-route-test.cjs'],
  'kick-overlay/route-gate.js': ['route-gate-test.cjs'],
  'kick-overlay/channel-switch.js': ['channel-switch-test.cjs'],
  'kick-overlay/player.html': ['bridge-handshake-test.cjs'],
  'kick-overlay/manifest.json': ['syntax.mjs'],
};
// Files with no behavioural suite of their own: the loop still syntax-checks
// them, and the gate's own checks cover their contract.
// A DEEP SUITE RUNS WHEN THE EDIT TOUCHES A LINE IT MUTATES. The heavy
// landing suite is absent from SUITES on purpose (7.5 s per edit), but a suite
// that mutates an exact source line is exactly the suite an edit to that line
// breaks - measured 2026-11-27: the 105-exit codemod passed this loop and left
// `ad-time-continuity` red on four mutation targets that no longer matched.
// Reading the suite's own targets keeps the loop cheap (1.1 s) for edits
// elsewhere and honest (the deep suite runs) where it can actually break.
const DEEP = {
  'kick-overlay/twitch-adblock.js': ['ad-time-continuity-test.cjs'],
};

function suiteTargets(suite) {
  const abs = path.join(OVERLAY, suite);
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, 'utf8');
  const out = [];
  for (const m of text.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)) {
    const lit = m[0];
    let body = lit.slice(1, -1);
    if (lit[0] === '"') { try { body = JSON.parse(lit); } catch { continue; } }
    else body = body.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    if (body.length >= 20 && /\b(return|if \()/.test(body)) out.push(body);
  }
  return out;
}

function changedLines(rel) {
  const r = spawnSync('git', ['-C', ROOT, 'diff', '-U0', '--', rel], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) return [];
  return String(r.stdout).split('\n')
    .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    .map((l) => l.slice(1).trim())
    .filter((l) => l.length >= 20);
}

const SYNTAX_ONLY = /^(kick-overlay\/(background|popup)\.js|_tools\/|harness\/|cookie-extension\/|instagram-followguard\/)/;
// State and prose, not code: the gate validates these through its own checks
// (budgets, feature map, ledger), so the edit loop has nothing to run.
const NOT_CODE = /(\.md|\.tsv|\.jsonl)$|^(benchmarks|features|revival|_evidence)\/.*\.(json|tsv)$/;
const FORMATS = /\.(js|mjs|cjs)$/;

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function changedFiles() {
  const r = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) return { ok: false, files: [], why: String(r.stderr || '').trim().slice(0, 200) };
  const files = [];
  for (const line of String(r.stdout).split('\n')) {
    if (!line.trim()) continue;
    let rel = line.slice(3).trim();
    if (rel.includes(' -> ')) rel = rel.split(' -> ').pop();
    files.push(rel.replace(/\\/g, '/'));
  }
  return { ok: true, files };
}

function checkSyntax(rel) {
  if (!FORMATS.test(rel)) return { ok: true, ms: 0, detail: 'not code' };
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return { ok: true, ms: 0, detail: 'deleted' };
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, ms: Date.now() - started, detail: String(r.stderr || '').trim().slice(0, 400) };
}

function runSuite(suite) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(OVERLAY, suite)], {
    cwd: OVERLAY, encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const verdict = /RESULT PASS|ALL CONTENT\.JS FIX CHECKS PASSED/.test(out);
  const failLine = (out.split('\n').filter((l) => /RESULT FAIL|HARNESS FAIL|FAIL |Error:/.test(l)).pop() || '').trim();
  // A suite holding the single-flight lock is already running (the landing gate owns
  // it). A feedback loop must not block AND must not read a refusal as a pass: this
  // is DEFERRED, its own verdict and its own exit code (measured 2026-11-27: two
  // concurrent copies of ad-time-continuity were the box's named top pressure).
  if (/HEAVY-LOCK refused/.test(out)) {
    const holder = (out.split('\n').find((l) => /HEAVY-LOCK refused/.test(l)) || '').trim();
    return { ok: true, deferred: true, ms: Date.now() - started, detail: holder.slice(0, 240) };
  }
  return { ok: r.status === 0 && verdict, ms: Date.now() - started, detail: failLine.slice(0, 240) };
}

const argv = process.argv.slice(2);
const explicit = argOf(argv, '--files');
const all = argv.includes('--all');
const json = argv.includes('--json');

let files;
if (all) {
  files = Object.keys(SUITES).concat(['kick-overlay/background.js', 'kick-overlay/popup.js']);
} else if (explicit) {
  files = explicit.split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
} else {
  const diff = changedFiles();
  if (!diff.ok) {
    console.error(`LOOP FAIL: git status failed (${diff.why})`);
    process.exitCode = 1;
    files = null;
  } else {
    files = diff.files;
  }
}

if (files && !all && files.length > 12) {
  // A diff this wide is a landing, not an edit: the narrow loop would spawn a
  // `node --check` per file and measure the box, not the change (measured
  // 2026-11-27: 30 spawns on a loaded box died with VirtualAlloc failures).
  console.log(`LOOP wide-diff files=${files.length}: run --all or node _tools/ko-verify.mjs (a landing, not an edit)`);
  process.exitCode = 2;
} else if (files) {
  const started = Date.now();
  const suites = new Set();
  const unmapped = [];
  const syntax = [];
  for (const rel of files) {
    const own = /^kick-overlay\/([a-z0-9-]+-test\.cjs)$/.exec(rel);
    if (SUITES[rel]) for (const s of SUITES[rel]) suites.add(s);
    else if (own) suites.add(own[1]);
    else if (NOT_CODE.test(rel)) continue;
    else if (SYNTAX_ONLY.test(rel)) syntax.push(rel);
    else if (FORMATS.test(rel) || /\.(json|html)$/.test(rel)) unmapped.push(rel);
  }
  // Deep tier: only when a changed line is one the suite mutates.
  for (const [prod, deepSuites] of Object.entries(DEEP)) {
    if (!files.includes(prod)) continue;
    const lines = changedLines(prod);
    if (!lines.length) continue;
    for (const suite of deepSuites) {
      if (suites.has(suite)) continue;
      const targets = suiteTargets(suite);
      const hit = lines.some((l) => targets.some((t) => t.includes(l) || t.trim() === l));
      if (hit) suites.add(suite);
    }
  }
  let failed = 0;
  for (const rel of [...new Set(syntax)]) {
    const r = checkSyntax(rel);
    if (!r.ok) { failed += 1; console.error(`LOOP FAIL syntax ${rel}: ${r.detail}`); }
  }
  if (unmapped.length) {
    failed += 1;
    console.error(`LOOP FAIL: no suite mapped for ${unmapped.join(', ')} — add it to SUITES in this file`);
  }
  const ran = [];
  const deferred = [];
  for (const suite of suites) {
    if (!existsSync(path.join(OVERLAY, suite))) {
      failed += 1;
      console.error(`LOOP FAIL: mapped suite is missing: ${suite}`);
      continue;
    }
    const r = runSuite(suite);
    ran.push({ suite, ...r });
    if (r.deferred) { deferred.push(suite); console.log(`LOOP DEFERRED ${suite}: ${r.detail}`); }
    else if (!r.ok) { failed += 1; console.error(`LOOP FAIL ${suite} (${r.ms}ms): ${r.detail}`); }
  }
  const wall = Date.now() - started;
  const verdict = failed > 0 ? 'FAIL'
    : (deferred.length > 0 ? 'DEFERRED'
      : (ran.length + syntax.length > 0 ? 'PASS' : 'NOTHING'));
  if (json) {
    console.log(JSON.stringify({ loop: verdict, wall_ms: wall, suites: ran, syntax, deferred, failed }));
  } else {
    console.log(`LOOP impacted=${files.length} suites=${ran.length} syntax=${syntax.length} wall=${wall}ms verdict=${verdict}`);
  }
  if (verdict === 'NOTHING') process.exitCode = 2;
  else if (verdict === 'FAIL') process.exitCode = 1;
  else if (verdict === 'DEFERRED') process.exitCode = 3;
}
