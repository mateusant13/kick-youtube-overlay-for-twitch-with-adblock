// Shared context and verdict primitives for the gate's per-check modules.
//
// `_tools/ko-verify.mjs` is the runner: it owns the ORDER of the checks and
// nothing else. Every check body lives in `_tools/gate/checks/*.mjs` and
// receives this context, so no module recomputes ROOT, re-reads a file this run
// already read, or prints a verdict in its own dialect.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function makeContext(ROOT) {
  const EXT = path.join(ROOT, 'kick-overlay');
  // One read per path per run: several checks hash or re-scan the same product
  // files, and a later check must see the same bytes the first one did.
  const cache = new Map();
  const state = {
    results: [],
    started: Date.now(),
    manifest: null,
    ledger: { schema: 1, bugs: [] },
    ledgerLoaded: false,
    // Raw stdout of the harnesses whose negative arm is the evidence a ledger
    // entry cites. The gate writes one _evidence/<bug>-arms.md per key.
    capturedArms: {},
    // Every suite this run actually spawned, with what it printed. The
    // `vacuous-green` check reads this array instead of trusting a PASS string.
    suiteRuns: [],
    armArtifacts: [],
    payload: null,
    gitHead: 'unknown',
    evidenceDir: path.join(ROOT, '_evidence'),
  };

  const ctx = {
    ROOT,
    EXT,
    state,
    read(rel) {
      const abs = path.join(ROOT, rel);
      if (!cache.has(abs)) cache.set(abs, readFileSync(abs, 'utf8'));
      return cache.get(abs);
    },
    sha256(text) {
      return createHash('sha256').update(text).digest('hex');
    },
    assert(condition, message) {
      if (!condition) throw new Error(message);
    },
    pass(name, detail = '') {
      state.results.push({ name, status: 'PASS', detail });
      console.log(`PASS ${name}${detail ? '  ' + detail : ''}`);
    },
    fail(name, error) {
      const detail = String(error && error.message ? error.message : error);
      state.results.push({ name, status: 'FAIL', detail });
      console.log(`FAIL ${name}  ${detail}`);
    },
    runCheck(name, fn) {
      try {
        ctx.pass(name, fn(ctx));
      } catch (error) {
        ctx.fail(name, error);
      }
    },
    runAll(defs) {
      for (const def of defs) ctx.runCheck(def.name, def.run);
    },
    // Record a suite the gate actually spawned. `out` is what the suite
    // printed, not a summary of it: the vacuity check has to see the counts.
    capture(check, rel, r) {
      state.suiteRuns.push({
        check,
        rel,
        status: r.status === 0 ? 'PASS' : 'FAIL',
        out: `${r.stdout || ''}${r.stderr || ''}`,
      });
    },
  };
  return ctx;
}
