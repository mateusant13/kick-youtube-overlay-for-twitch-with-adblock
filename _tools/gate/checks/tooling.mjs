// ---- 9. tooling contracts ---------------------------------------------------
//
// The gate's own instruments are checked here, for the same reason every other
// detector carries a negative arm: a tool nobody tests is a comment. Each entry
// spawns the tool's own test, which prints a counted PASS verdict; the check
// refuses a verdict with zero checks.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function runToolTest(ctx, check, rel, verdictRe) {
  ctx.assert(existsSync(path.join(ctx.ROOT, rel)), `missing ${rel}`);
  const r = spawnSync(process.execPath, [path.join(ctx.ROOT, rel)], { timeout: 120000, killSignal: 'SIGKILL', cwd: ctx.ROOT, encoding: 'utf8' });
  ctx.capture(check, rel, r);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ctx.assert(r.status === 0, `${rel}: ${out.trim().slice(-400)}`);
  const m = verdictRe.exec(out);
  ctx.assert(m && Number(m[1]) > 0, `${rel}: no counted PASS verdict (${out.trim().slice(-200)})`);
  return m;
}

export const toolingChecks = [
  {
    // `ko-load-check.mjs` is the left side of the project's `&&`: a BUSY reading
    // must exit 2 so the heavy gate is QUEUED, not started. The test proves the
    // JSON contract, the 0/2/3 exit mapping and the `&&` refusal with fixtures,
    // so it never depends on the machine's real load.
    name: 'load-check-json',
    run(ctx) {
      const m = runToolTest(ctx, 'load-check-json', '_tools/gate/load-check-test.mjs',
        /RESULT PASS load-check-json checks=(\d+) failed=0/);
      return `load pre-flight JSON contract + exit codes 0/2/3 proven, checks=${m[1]}`;
    },
  },
];
