// Virtual clock for the two timer-heavy stub-world suites. One timeline is
// shared by every world in a suite and by the suite's own `settle()` helper,
// so `Date.now()`, `performance.now()`, `setTimeout` and `setInterval` inside a
// stub world advance together with the test that drives them.
//
// KO_REAL_CLOCK=1 passes the timer and clock calls through to the real host
// (the old wall-clock behaviour) so a suspect arm can be re-measured as before.
'use strict';

const realSetTimeout = global.setTimeout.bind(global);
const realClearTimeout = global.clearTimeout.bind(global);
const realSetInterval = global.setInterval.bind(global);
const realClearInterval = global.clearInterval.bind(global);
const realDateNow = Date.now.bind(Date);

const REAL = process.env.KO_REAL_CLOCK === '1';
const MAX_TIMERS_PER_ADVANCE = 100000;

class VirtualClockRunawayError extends Error {
  constructor(fired) {
    super(`virtual clock fired ${fired} timers in one advance (cap ${MAX_TIMERS_PER_ADVANCE})`);
    this.name = 'VirtualClockRunawayError';
    this.fired = fired;
  }
}

const baseMs = realDateNow();
let elapsed = 0;
let skew = 0;
let nextId = 1;
let nextSeq = 1;
const timers = new Map(); // id -> { id, due, seq, fn, args, delay }

// Scheduling time deliberately excludes the test-only skew: injecting a skew
// changes what the world READS as now, never when its timers are due.
function scheduledNow() {
  return REAL ? realDateNow() : baseMs + elapsed;
}

function now() {
  return REAL ? realDateNow() + skew : baseMs + elapsed + skew;
}

function addTimer(fn, ms, repeat) {
  const delay = Math.max(0, Number(ms) || 0);
  const id = nextId++;
  timers.set(id, {
    id,
    due: scheduledNow() + delay,
    seq: nextSeq++,
    fn,
    args: Array.prototype.slice.call(arguments, 3),
    delay,
    repeat,
  });
  return id;
}
const setTimeoutVirtual = (fn, ms, ...args) => addTimer(fn, ms, false, ...args);
const setIntervalVirtual = (fn, ms, ...args) => addTimer(fn, ms, true, ...args);

function clearTimer(handle) {
  timers.delete(handle);
}

function advance(ms) {
  if (REAL) {
    return new Promise((resolve) => realSetTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }
  const target = scheduledNow() + Math.max(0, Number(ms) || 0);
  let fired = 0;
  for (;;) {
    let next = null;
    for (const t of timers.values()) {
      if (t.due > target) continue;
      if (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq)) next = t;
    }
    if (!next) break;
    if (++fired > MAX_TIMERS_PER_ADVANCE) throw new VirtualClockRunawayError(fired - 1);
    timers.delete(next.id);
    // Move to the timer's own due time, never to `now()` after a long callback.
    elapsed += next.due - scheduledNow();
    if (next.repeat) {
      next.due += next.delay; // interval reschedules from its own due time
      timers.set(next.id, next);
    }
    next.fn.apply(null, next.args);
  }
  elapsed += target - scheduledNow();
  return undefined;
}

// A Date view whose now() reads the same timeline; `new Date(...)` still has
// the native constructors/parsers.
class DateView extends Date {
  static now() {
    return now();
  }
}

const performanceView = { now };

const clock = {
  real: REAL,
  now,
  Date: DateView,
  performance: performanceView,
  setTimeout: REAL ? realSetTimeout : setTimeoutVirtual,
  clearTimeout: REAL ? realClearTimeout : clearTimer,
  setInterval: REAL ? realSetInterval : setIntervalVirtual,
  clearInterval: REAL ? realClearInterval : clearTimer,
  advance,
  // Test-only clock skew (the owner-attribute flapping arm); never changes
  // when timers are due, only what Date.now()/performance.now() report.
  setSkew: (ms) => { skew = Number(ms) || 0; },
  pending: () => timers.size,
  MAX_TIMERS_PER_ADVANCE,
  VirtualClockRunawayError,
};

module.exports = clock;
