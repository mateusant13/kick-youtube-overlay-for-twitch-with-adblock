#!/usr/bin/env node
// IS THE BOX READY FOR THE ONE HEAVY STEP? Read it BEFORE the step, not after it
// hurts (owner order 2026-11-11; measured again 2026-11-26 with the whole box
// pinned: 12 P-cores at 77% mean, all 8 E-cores at 100%, and this repo's gate
// then taking ~330 s on a SMR volume with 9 GB free).
//
// `ko-verify.mjs` is this project's one heavy step: a serial chain of suites on
// a spindle. Starting it while every core is already spoken for does not make
// the landing faster, it makes the whole box stop answering - the owner's
// report is literally "the PC is freezing".
//
// Two samples, DELTA over busy/idle time per core, so a snapshot cannot be
// mistaken for a load. Reads `os.cpus()` only: no child process, no tree walk,
// no disk I/O. Ceiling: two 1.5 s samples, one process, < 5 MB RSS.
//
//   node _tools/ko-load-check.mjs            # print the reading
//   node _tools/ko-load-check.mjs --gate     # exit 2 when the box is busy
//   node _tools/ko-load-check.mjs --json     # explicit machine form (default is already one JSON line)
//
// Exit codes: 0 ready (or informational), 2 busy -> QUEUE the heavy step,
// 3 CANNOT-MEASURE (the counters did not advance).
import { readLoad } from './gate/load-sample.mjs';
import { exitCodeFor } from './gate/load-verdict.mjs';

const GATE = process.argv.includes('--gate');
// `--json` is accepted for callers that want the machine form spelled out;
// the default already prints exactly one JSON line, so it changes no bytes.
const SAMPLE_MS = Number(process.env.KO_LOAD_SAMPLE_MS || 1500);
const MAX_TOTAL = Number(process.env.KO_LOAD_MAX_TOTAL || 70); // % of the whole box
const MAX_CORE = Number(process.env.KO_LOAD_MAX_CORE || 90); // % of one core, any core

// TEST ONLY: KO_LOAD_FIXTURE substitutes deterministic snapshots so the
// exit-code contract is testable without depending on the machine's real load.
// Unset in normal use; no other behaviour reads it.
const FIXTURE = process.env.KO_LOAD_FIXTURE;

// When running live (`--gate` without a test `KO_LOAD_FIXTURE`), defer to Watcher's
// centralized Traffic Light (`GET /traffic/status`):
//   - GREEN (owner idle/AFK) or YELLOW -> READY (exit 0) immediately; heavy commands
//     queue inside Watcher's Traffic Light rather than failing BUSY on CPU spikes.
//   - RED (true OOM / gaming / saturated disk) -> WAIT in-process until GREEN/YELLOW
//     (up to KO_LOAD_WAIT_CEILING_S, default 600s) instead of returning BUSY and
//     forcing agents into manual `sleep 90` polling loops.
//   - Unreachable daemon -> falls back to the local os.cpus() check below.
async function probeWatcherTraffic(host, port, timeoutMs = 1500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer?.unref?.();
  try {
    const resp = await fetch(`http://${host}:${port}/traffic/status`, { signal: ac.signal });
    if (!resp.ok) return null;
    const doc = await resp.json();
    const light = String(doc?.light || '').toUpperCase();
    if (!light) return null;
    return { light, reason: String(doc?.reason || ''), max_slots: doc?.max_slots ?? null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

if (GATE && !FIXTURE && process.env.KO_LOAD_LOCAL_ONLY !== '1') {
  const host = process.env.WATCHER_BUS_HOST || '127.0.0.1';
  const port = Number(process.env.WATCHER_BUS_PORT || 47891);
  const ceilingS = Math.max(10, Number(process.env.KO_LOAD_WAIT_CEILING_S || 600));
  const pollMs = Math.max(1000, Number(process.env.KO_LOAD_POLL_MS || 5000));
  const started = Date.now();
  let reading = await probeWatcherTraffic(host, port);
  if (reading) {
    while (reading && reading.light === 'RED' && (Date.now() - started) < ceilingS * 1000) {
      await new Promise((r) => setTimeout(r, pollMs));
      reading = await probeWatcherTraffic(host, port);
    }
    const waitedS = Number(((Date.now() - started) / 1000).toFixed(1));
    if (!reading || reading.light === 'GREEN' || reading.light === 'YELLOW') {
      console.log(JSON.stringify({
        verdict: 'READY',
        via: 'watcher-traffic-light',
        light: reading?.light || 'FAIL-OPEN',
        reason: reading?.reason || 'daemon-unreachable-mid-wait',
        waited_s: waitedS,
      }));
      process.exit(0);
    }
    console.log(JSON.stringify({
      verdict: 'BUSY',
      via: 'watcher-traffic-light',
      light: reading.light,
      reason: reading.reason,
      waited_s: waitedS,
      why: `watcher traffic light stayed RED (${reading.reason}) for ${waitedS}s`,
    }));
    process.exit(2);
  }
}

// The sampling window and the os.cpus() reads live in gate/load-sample.mjs, because
// the timing wrapper (`ko-timed-suite.mjs`) asks the same question and two
// conventions for "is the box ready" is the defect this instrument exists to stop.
const out = await readLoad({ sampleMs: SAMPLE_MS, total: MAX_TOTAL, core: MAX_CORE, fixture: FIXTURE });
if (out.verdict === 'CANNOT-MEASURE' && String(out.why || '').startsWith('bad KO_LOAD_FIXTURE')) {
  console.log(JSON.stringify({ verdict: 'CANNOT-MEASURE', why: 'bad KO_LOAD_FIXTURE value' }));
  process.exit(3);
}
console.log(JSON.stringify(out));
process.exit(exitCodeFor(out.verdict, { gate: GATE }));
