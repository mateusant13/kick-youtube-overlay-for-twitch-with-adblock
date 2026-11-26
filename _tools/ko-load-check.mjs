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
import os from 'node:os';
import { evaluateLoad, exitCodeFor } from './gate/load-verdict.mjs';

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

function snap() {
  return os.cpus().map((c) => {
    const t = c.times;
    const idle = t.idle;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle, total };
  });
}

function fixturePair(kind, cores) {
  const before = Array.from({ length: cores }, () => ({ idle: 0, total: 1000 }));
  if (kind === 'ready') {
    return [before, Array.from({ length: cores }, () => ({ idle: 1000, total: 2000 }))];
  }
  if (kind === 'busy') {
    return [before, Array.from({ length: cores }, () => ({ idle: 0, total: 2000 }))];
  }
  // 'cannot': identical snapshots, so no counter advances in the window.
  return [before, before.map((s) => ({ ...s }))];
}

let a;
let b;
if (FIXTURE === undefined) {
  a = snap();
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  b = snap();
} else {
  if (FIXTURE !== 'ready' && FIXTURE !== 'busy' && FIXTURE !== 'cannot') {
    console.log(JSON.stringify({ verdict: 'CANNOT-MEASURE', why: 'bad KO_LOAD_FIXTURE value' }));
    process.exit(3);
  }
  [a, b] = fixturePair(FIXTURE, Math.max(os.cpus().length, 1));
}

const out = evaluateLoad(a, b, { total: MAX_TOTAL, core: MAX_CORE, windowMs: SAMPLE_MS });
console.log(JSON.stringify(out));
process.exit(exitCodeFor(out.verdict, { gate: GATE }));
