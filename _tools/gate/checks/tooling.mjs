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
    // it appeared only as data rows in `harness/angulos.tsv` - so the twin grader's
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
    // only ever exercised as data rows in `harness/angulos.tsv`, so their refusal
    // contracts were untested: a plant that restored BEFORE the child ran, or a
    // bypass that never returned the child's rc, would have printed a green row.
    //
    // Measured 2026-11-27 why this must be a check and not an assumption: the two
    // launchers spawn with `shell: true`, and an inline `node -e` falsifier lost
    // its quoting at cmd.exe (`expected ',', got '<eof>'`) - the arms below use a
    // FILE probe, which is the shape `angulos.tsv` already passes.
    //
    // 17 arms, 62 checks, measured ~2.8 s: it starts no suite, only small fixtures.
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
      const m = /RESULT PASS harness-tools checks=(\d+) failed=0 arms=(\d+)\/17/.exec(out);
      ctx.assert(m, `${rel}: no PASS verdict with all 17 arms counted:\n${out.trim().slice(-400)}`);
      return `plant + cwd launchers proven (${m[1]} checks, ${m[2]} arms counted): a plant restores after the child, a restore mismatch outranks a child exit 0, signals and a crash replay a target-derived journal, a stale/ambiguous/empty anchor and a missing falsifier refuse rc 3, and the cwd launcher refuses rc 2 while its child runs from the declared directory`;
    },
  },
  {
    // Measured 2026-11-27 (audit A3GateRevival): `prepareReceipt` ran outside
    // `runCheck`, so a throw there aborted before `finalizeReceipt` - and JSON is
    // written only by `finalizeReceipt`, leaving the PREVIOUS receipt on disk as
    // `result: PASS` beside a crashed run. The gate's own artifact lied about the
    // gate. `crashReceipt` now writes FAIL; this check proves both directions and
    // that the happy path was not disturbed.
    name: 'crash-receipt',
    run(ctx) {
      const rel = '_tools/gate/crash-receipt-selftest.mjs';
      const script = path.join(ctx.ROOT, rel);
      ctx.assert(existsSync(script), `missing ${rel}`);
      const r = spawnSync(process.execPath, [script],
        { timeout: 120000, killSignal: 'SIGKILL', cwd: ctx.ROOT, encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      ctx.capture('crash-receipt', rel, r);
      ctx.assert(r.status === 0, `${rel} failed:\n${out.trim().slice(-600)}`);
      const m = /RESULT PASS crash-receipt checks=(\d+) failed=0/.exec(out);
      ctx.assert(m, `${rel}: no PASS verdict for the crash path:\n${out.trim().slice(-400)}`);
      const arms = /ARMS (\d+)\/3 present/.exec(out);
      ctx.assert(arms && arms[1] === '3', `${rel}: expected 3 entered arms, saw ${arms ? arms[1] : 'none'}`);
      return `crash path proven both ways (${m[1]} checks, 3 arms): a throw outside a check body writes a FAIL receipt, the pre-fix sequence provably leaves a stale PASS on disk, and the happy path still writes PASS`;
    },
  },
  {
    // Measured 2026-11-27 (audit A3GateRevival): `verified` and `state` were two
    // predicates for one claim, decided in three files. `state:'fixed',
    // verified:true` was counted as verified-with-evidence, skipped by the
    // artifact binding, and absent from FIXED-NOT-VERIFIED. `bug-state.mjs` is now
    // the single definition and `ledger-evidence` refuses any row where the two
    // sides disagree. This check proves the definition and both hole directions.
    name: 'ledger-invariant',
    run(ctx) {
      const rel = '_tools/gate/ledger-invariant-selftest.mjs';
      const script = path.join(ctx.ROOT, rel);
      ctx.assert(existsSync(script), `missing ${rel}`);
      const r = spawnSync(process.execPath, [script],
        { timeout: 120000, killSignal: 'SIGKILL', cwd: ctx.ROOT, encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      ctx.capture('ledger-invariant', rel, r);
      ctx.assert(r.status === 0, `${rel} failed:\n${out.trim().slice(-600)}`);
      const m = /RESULT PASS ledger-invariant checks=(\d+) failed=0/.exec(out);
      ctx.assert(m, `${rel}: no PASS verdict for the invariant:\n${out.trim().slice(-400)}`);
      const arms = /ARMS (\d+)\/4 present/.exec(out);
      ctx.assert(arms && arms[1] === '4', `${rel}: expected 4 entered arms, saw ${arms ? arms[1] : 'none'}`);
      return `one definition of "verified" proven (${m[1]} checks, 4 arms): both divergence directions are refused, and a dated claim or an idle row agrees on both sides`;
    },
  },
];
