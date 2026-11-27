// Pure decision logic for the load pre-flight: no I/O, no clock, no process.exit.
// The CLI samples os.cpus() and calls these functions; the test calls them with
// the same sample shape, so one predicate owns both the verdict and the exit code.

const READY_ADVICE = 'one heavy step at a time is allowed now (the gate is that step)';
const QUEUE_ADVICE = 'QUEUE the heavy step: the box has no headroom, and a suite started now buys wall time and steals the owner\'s machine';

export function evaluateLoad(before, after, ceilings) {
  if (before.length !== after.length || before.length === 0) {
    return {
      verdict: 'CANNOT-MEASURE',
      why: 'core count changed between samples',
      cores: before.length,
    };
  }

  let advanced = 0;
  const perCore = before.map((s, i) => {
    const dt = after[i].total - s.total;
    const di = after[i].idle - s.idle;
    if (dt <= 0) return null;
    advanced += 1;
    return Math.round((1 - di / dt) * 1000) / 10;
  });

  if (advanced === 0) {
    return {
      verdict: 'CANNOT-MEASURE',
      why: 'no cpu counter advanced in the window',
      windowMs: ceilings.windowMs,
    };
  }

  const cores = perCore.filter((x) => x !== null);
  const total = Math.round((cores.reduce((s, x) => s + x, 0) / cores.length) * 10) / 10;
  const pinned = cores.filter((x) => x > ceilings.core).length;
  const busiest = Math.max(...cores);
  const ready = total <= ceilings.total && pinned === 0;

  // WHICH CEILING BROKE, because the reading alone cannot say it and a lane read
  // the wrong one (measured 2026-11-27: `BUSY total=57.2% ... ceilings total 70%`
  // was refused for its CORE ceiling, and `57.2` sits under `70`, so the receipt
  // invited "why did this refuse?" and the answer lived in a predicate instead of
  // in the message). Lowering `total` under a busy core never clears this guard;
  // naming the breach is what makes that legible without reading the source.
  const overTotal = total > ceilings.total;
  const breach = ready ? null : overTotal && pinned ? 'total+pinned' : overTotal ? 'total' : 'pinned';
  const why = ready
    ? null
    : breach === 'pinned'
      ? `${pinned} core(s) above ${ceilings.core}% (busiest ${busiest}%), while the total ${total}% stays under its ${ceilings.total}% ceiling`
      : breach === 'total'
        ? `total ${total}% above its ${ceilings.total}% ceiling (busiest ${busiest}%)`
        : `total ${total}% above its ${ceilings.total}% ceiling AND ${pinned} core(s) above ${ceilings.core}% (busiest ${busiest}%)`;

  return {
    verdict: ready ? 'READY' : 'BUSY',
    windowMs: ceilings.windowMs,
    cores: cores.length,
    total,
    busiest,
    pinned,
    breach,
    why,
    ceilings: { total: ceilings.total, core: ceilings.core },
    perCore: cores,
    advice: ready ? READY_ADVICE : QUEUE_ADVICE,
  };
}

export function exitCodeFor(verdict, { gate = false } = {}) {
  if (verdict === 'READY') return 0;
  if (verdict === 'BUSY') return gate ? 2 : 0;
  if (verdict === 'CANNOT-MEASURE') return 3;
  throw new Error(`unknown load verdict: ${verdict}`);
}
