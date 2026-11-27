// SINGLE-FLIGHT FOR THIS LANE'S HEAVY STEPS.
//
// Measured 2026-11-27 (watcher DM `dm-f77bd3e66a863677296f`, owner order "é pra
// sempre verificar o maior culpado do stutter"): `node kick-overlay/
// ad-time-continuity-test.cjs` (pid 92684) was named the box's top pressure
// while TWO copies of it ran at once - the landing gate and the edit loop's new
// deep tier both spawned it - on a box already at 64 % CPU, `I:` at 419.9 %
// busy with a 50.7 ms queue (`python -m watcher perf`, same minute).
//
// The cost is not the suite: it is the SECOND copy. One copy is 7.5 s and one
// core; two copies double the compile work (`new Function` over a 6 500-line
// product, once per arm) and the spindle queue, and neither finishes sooner.
// This lock is the fix at the source: the second caller is refused in under a
// millisecond, with the holder's pid, instead of being served.
//
// Dialect: CommonJS because the suites that need it are `.cjs` and are loaded
// from `kick-overlay/` as well as from `_tools/gate/`.
const { readFileSync, writeFileSync, unlinkSync, mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');

// The lock lives in the OS temp dir, never in the checkout: a lock is a
// runtime fact, and a tracked lock file is a conflict waiting for two lanes.
function lockPath(name) {
  const dir = join(tmpdir(), 'ko-heavy');
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return join(dir, `${name}.lock`);
}

function alive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// A lock whose holder died (or that outlived every ceiling this project has)
// is stale: stealing it is the only way a crashed run cannot wedge the lane.
const STALE_MS = 20 * 60 * 1000;

// A caller that MUST land (the landing gate) queues behind the holder instead of
// being refused; a caller that must not block (the edit loop) keeps waitMs 0 and
// is refused at once. Both paths run ONE copy at a time, which is the point.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* no worker_threads: busy-wait is not worth it, just return */ }
}

function singleFlight(name, { staleMs = STALE_MS, waitMs = 0, now = Date.now } = {}) {
  const deadline = now() + Math.max(0, waitMs);
  for (;;) {
    const taken = tryTake(name, { staleMs, now });
    if (taken.ok || now() >= deadline) return taken;
    sleepSync(250);
  }
}

function tryTake(name, { staleMs, now }) {
  const at = now();
  const path = lockPath(name);
  let held = null;
  try {
    held = JSON.parse(readFileSync(path, 'utf8'));
  } catch { /* no lock, or unreadable: ours to take */ }
  if (held && alive(held.pid) && at - held.at < staleMs) {
    return { ok: false, path, pid: held.pid, at: held.at, since: at - held.at };
  }
  const mine = { pid: process.pid, at, cmd: String(process.argv[1] || '').slice(-120) };
  try {
    writeFileSync(path, JSON.stringify(mine));
  } catch (error) {
    // A lock we cannot write must not stop the work; it must SAY so.
    console.error(`HEAVY-LOCK unavailable (${error.code || error.message}); running unlocked: ${name}`);
    return { ok: true, path, unlocked: true, release() {} };
  }
  let released = false;
  return {
    ok: true,
    path,
    stale: !!held,
    release() {
      if (released) return;
      released = true;
      try {
        const cur = JSON.parse(readFileSync(path, 'utf8'));
        if (cur.pid === mine.pid) unlinkSync(path);
      } catch { /* already gone */ }
    },
  };
}

module.exports = { singleFlight, lockPath, alive, STALE_MS, dirname };
