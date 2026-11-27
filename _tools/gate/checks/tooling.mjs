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
  {
    // THE GRADER'S OWN TWO-DIRECTION PROOF MUST RUN IN THE GATE, NOT ON REQUEST.
    //
    // MEASURED 2026-11-27: `replay.mjs --corrupt` was invoked by no check at all -
    // it appeared only as data rows in `harness/angles.tsv` - so the twin grader's
    // ability to FAIL was optional. A green twin row cannot distinguish "the product
    // is right" from "the grader never looked" without it, which is exactly the class
    // this file exists to refuse.
    //
    // One twin, not `--all`: the ring twin grades in 0.67 s (measured), while
    // `--all` spawns the yt-route suite and would add its wall time to every gate run.
    // `corruptTwin` now also grades the UNMUTATED artifact and requires it to PASS,
    // so the arm proves the grader discriminates rather than failing everything.
    name: 'twin-grader-two-way',
    run(ctx) {
      const rel = 'harness/twins/replay.mjs';
      const script = path.join(ctx.ROOT, rel);
      ctx.assert(existsSync(script), `missing ${rel}`);
      const r = spawnSync(process.execPath, [script, '--corrupt', '--twin', 'dev-handback-wait'],
        { timeout: 120000, killSignal: 'SIGKILL', cwd: ctx.ROOT, encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      ctx.capture('twin-grader-two-way', rel, r);
      ctx.assert(r.status === 0, `${rel} --corrupt failed:\n${out.trim().slice(-500)}`);
      const m = /TWIN CORRUPT PASS (\S+) reason=grader caught the corrupt artifact .* and passed the real one/.exec(out);
      ctx.assert(m, `${rel}: the corrupt artifact was not proven caught in both directions:\n${out.trim().slice(-400)}`);
      return `twin grader proven two-way on ${m[1]}: a mutated recording FAILs and the real one PASSes (a grader that failed everything would not satisfy this)`;
    },
  },
  {
    // The two harness launchers every mutating angle row goes through. Both were
    // only ever exercised as data rows in `harness/angles.tsv`, so their refusal
    // contracts were untested: a plant that restored BEFORE the child ran, or a
    // bypass that never returned the child's rc, would have printed a green row.
    //
    // Measured 2026-11-27 why this must be a check and not an assumption: the two
    // launchers spawn with `shell: true`, and an inline `node -e` falsifier lost
    // its quoting at cmd.exe (`expected ',', got '<eof>'`) - the arms below use a
    // FILE probe, which is the shape `angles.tsv` already passes.
    //
    // 9 arms, 23 checks, measured ~1.3 s: it starts no suite, only two tiny probes.
    name: 'harness-tools',
    run(ctx) {
      const rel = '_tools/gate/harness-tools-selftest.mjs';
      const script = path.join(ctx.ROOT, rel);
      ctx.assert(existsSync(script), `missing ${rel}`);
      const r = spawnSync(process.execPath, [script],
        { timeout: 120000, killSignal: 'SIGKILL', cwd: ctx.ROOT, encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      ctx.capture('harness-tools', rel, r);
      ctx.assert(r.status === 0, `${rel} failed:\n${out.trim().slice(-600)}`);
      const m = /RESULT PASS harness-tools checks=(\d+) failed=0 arms=(\d+)\/9/.exec(out);
      ctx.assert(m, `${rel}: no PASS verdict with all 9 arms counted:\n${out.trim().slice(-400)}`);
      return `plant + cwd launchers proven (${m[1]} checks, ${m[2]} arms counted): a plant restores after the child, the mutation is visible while it runs, a stale/ambiguous/empty anchor and a missing falsifier refuse rc 3, and the cwd launcher refuses rc 2 while its child runs from the declared directory`;
    },
  },
];
