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
//
// Exit codes: 0 ready (or informational), 2 busy -> QUEUE the heavy step,
// 3 CANNOT-MEASURE (the counters did not advance).
import os from 'node:os';

const GATE = process.argv.includes('--gate');
const SAMPLE_MS = Number(process.env.KO_LOAD_SAMPLE_MS || 1500);
const MAX_TOTAL = Number(process.env.KO_LOAD_MAX_TOTAL || 70); // % of the whole box
const MAX_CORE = Number(process.env.KO_LOAD_MAX_CORE || 90); // % of one core, any core

const CPU_COUNT = os.cpus().length;

function snap() {
  return os.cpus().map((c) => {
    const t = c.times;
    const idle = t.idle;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle, total };
  });
}

const a = snap();
await new Promise((r) => setTimeout(r, SAMPLE_MS));
const b = snap();

if (a.length !== b.length || a.length === 0) {
  console.log(JSON.stringify({ verdict: 'CANNOT-MEASURE', why: 'core count changed between samples', cores: CPU_COUNT }));
  process.exit(3);
}

let advanced = 0;
const perCore = a.map((s, i) => {
  const dt = b[i].total - s.total;
  const di = b[i].idle - s.idle;
  if (dt <= 0) return null;
  advanced += 1;
  return Math.round((1 - di / dt) * 1000) / 10;
});

if (advanced === 0) {
  console.log(JSON.stringify({ verdict: 'CANNOT-MEASURE', why: 'no cpu counter advanced in the window', windowMs: SAMPLE_MS }));
  process.exit(3);
}

const cores = perCore.filter((x) => x !== null);
const total = Math.round((cores.reduce((s, x) => s + x, 0) / cores.length) * 10) / 10;
const pinned = cores.filter((x) => x > MAX_CORE).length;
const busiest = Math.max(...cores);
const ready = total <= MAX_TOTAL && pinned === 0;

const out = {
  verdict: ready ? 'READY' : 'BUSY',
  windowMs: SAMPLE_MS,
  cores: cores.length,
  total,
  busiest,
  pinned,
  ceilings: { total: MAX_TOTAL, core: MAX_CORE },
  perCore: cores,
  advice: ready
    ? 'one heavy step at a time is allowed now (the gate is that step)'
    : 'QUEUE the heavy step: the box has no headroom, and a suite started now buys wall time and steals the owner\'s machine',
};
console.log(JSON.stringify(out));
process.exit(ready || !GATE ? 0 : 2);
