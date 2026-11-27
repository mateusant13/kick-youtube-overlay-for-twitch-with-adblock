// Self-test for the single-flight lock (`_tools/ko-heavy-lock.cjs`).
//
// The defect it exists for, measured 2026-11-27 (watcher DM
// `dm-f77bd3e66a863677296f`, owner order "é pra sempre verificar o maior culpado
// do stutter"): `node kick-overlay/ad-time-continuity-test.cjs` was the box's
// named top pressure while TWO copies ran at once - the landing gate and the edit
// loop's deep tier - on a box already at 64 % CPU with `I:` at 419.9 % busy and a
// 50.7 ms queue. One copy finishes in the same wall the pair needed, with half the
// compile work and half the spindle pressure.
//
// Three properties, each with the failure it forbids:
//   refuse  - a second caller is told WHO holds the lock, in < 200 ms (never a
//             second copy of the work);
//   queue   - a caller that must land (`waitMs`) WAITS for the holder and never
//             steals it mid-run;
//   stale   - a holder that died does not wedge the lane (steal, and say so).
//
// `node _tools/gate/heavy-lock-selftest.mjs`
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { singleFlight, lockPath } = require('../ko-heavy-lock.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const LOCK_DIR = path.dirname(lockPath('x'));
const NAME = `selftest-${process.pid}`;
const checks = [];
const ARMS = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  console.log(`- ${ok ? 'OK' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
}
function arm(label) {
  ARMS.push(label);
  console.log(`ARM ${label}`);
}

// A holder in another process: the lock is per-pid, so a same-process holder
// could not prove anything about a second caller.
function holderScript(ms, name) {
  return `const { singleFlight } = require(${JSON.stringify(path.join(ROOT, '_tools/ko-heavy-lock.cjs'))});` +
    `const l = singleFlight(${JSON.stringify(name)});` +
    `if (!l.ok) { console.error('HOLDER refused'); process.exit(4); }` +
    `const t = Date.now(); while (Date.now() - t < ${ms}) {}` +
    `l.release(); console.log('HOLDER released');`;
}

function startHolder(ms, name) {
  const child = spawn(process.execPath, ['-e', holderScript(ms, name)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ready = new Promise((resolve) => child.on('spawn', resolve));
  return { child, ready, output: () => out };
}

function waitLockFile(name, timeoutMs) {
  // The holder writes the lock as its first statement; poll the file, not the pid
  // list, because the file is the contract a second caller reads.
  const file = lockPath(name);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      let held = null;
      try { held = JSON.parse(readFileSync(file, 'utf8')); } catch { /* not yet */ }
      if (held && held.pid) return resolve(held);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(tick, 20);
    };
    tick();
  });
}

(async () => {
  mkdirSync(LOCK_DIR, { recursive: true });

  // ---- arm 1: refuse a second caller, fast, naming the holder ---------------
  arm('refuse');
  {
    const h = startHolder(3000, NAME);
    await h.ready;
    const held = await waitLockFile(NAME, 3000);
    check('the holder took the lock', !!held, held ? `pid=${held.pid}` : 'no lock file');
    const t0 = Date.now();
    const second = singleFlight(NAME, { waitMs: 0 });
    const elapsed = Date.now() - t0;
    check('a second caller is refused', second.ok === false);
    check('the refusal names the holder', second.ok === false && second.pid === h.child.pid,
      second.ok === false ? `pid=${second.pid} expected=${h.child.pid}` : 'second caller took the lock');
    check('the refusal costs under 200 ms', elapsed < 200, `${elapsed}ms`);

    // ---- arm 2: a caller that must land waits, then takes it ----------------
    arm('queue');
    const t1 = Date.now();
    const queued = singleFlight(NAME, { waitMs: 15000 });
    const waited = Date.now() - t1;
    check('a queued caller takes the lock', queued.ok === true);
    check('it waited for the holder instead of stealing it', waited >= 800, `${waited}ms`);
    if (queued.ok) queued.release();
  }

  // ---- arm 3: a dead holder does not wedge the lane -------------------------
  arm('stale');
  {
    const file = lockPath(NAME);
    writeFileSync(file, JSON.stringify({ pid: 999999, at: Date.now(), cmd: 'dead' }));
    const stolen = singleFlight(NAME, { waitMs: 0 });
    check('a dead holder is stolen from', stolen.ok === true);
    check('the steal is reported, not silent', stolen.ok === true && stolen.stale === true);
    if (stolen.ok) stolen.release();
  }

  // ---- arm 4: release frees the name ---------------------------------------
  arm('release');
  {
    const a = singleFlight(NAME);
    check('a fresh name is taken', a.ok === true);
    a.release();
    try { rmSync(lockPath(NAME)); } catch { /* release already removed it */ }
    const b = singleFlight(NAME);
    check('after release the name is free again', b.ok === true);
    if (b.ok) b.release();
  }

  const failed = checks.filter((c) => !c.ok).length;
  const told = ARMS.length;
  const ok = failed === 0 && told === 4;
  console.log(`RESULT ${ok ? 'PASS' : 'FAIL'} heavy-lock checks=${checks.length} failed=${failed} arms=${told}/4`);
  if (told !== 4) console.error(`ARMS never printed: expected 4, printed ${told}`);
  process.exitCode = ok ? 0 : 1;
})();
