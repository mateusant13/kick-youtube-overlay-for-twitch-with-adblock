#!/usr/bin/env node
// ARMS FOR THE TWO HARNESS TOOLS THE MATRIX RUNS.
//
// MEASURED 2026-11-27: `_tools/harness-plant.mjs` and `_tools/harness-cwd.mjs` were
// invoked by NO gate check. They appeared only as data commands inside
// `harness/angulos.tsv`, so the two tools every red matrix arm depends on could break
// while the matrix stayed green: a plant that never restored its bytes would corrupt
// the tree, and a plant whose anchor went stale would refuse while the row still read
// "red arm refused as designed".
//
// NOTHING TRACKED IS MUTATED BY THIS TEST. The plant arms use a fixture under
// `G:/Temp/ko-scratch` (which is why `harness-plant.mjs` now accepts an absolute
// `--file`): a kill between write and restore must never leave a mutant in the
// checkout, and a selftest is not an exception to that rule.
//
//   1. plant restore  -> anchor planted, falsifier ran, `restored=true`, bytes identical
//   2. plant missing  -> an anchor that does not exist REFUSES rc 3 (never a silent plant)
//   3. plant ambiguous-> an anchor occurring twice REFUSES rc 3 rather than guessing
//   4. plant empty --to -> REFUSES rc 3 (a delete must be asked for, not implied)
//   5. plant no child -> REFUSES rc 3 (a mutation with no falsifier proves nothing)
//   6. cwd missing dir-> rc 2, refusal names the directory
//   7. cwd no args    -> rc 2, refusal prints the usage
//   8. cwd runs child -> a relative read that only resolves one directory down
//   9. cwd runs child -> (continued) `manifest.json` resolves from kick-overlay
//  10. restore mismatch-> child exits 0 but a failed restore wins: rc 4, journal kept
//  11. red: the pre-fix ordering prints a mismatch yet still exits 0
//  12. handlers/throws -> SIGINT, SIGTERM, SIGHUP and uncaughtException restore bytes
//  13. red: with no handler an in-process SIGTERM changes nothing
//  14. SIGTERM kill -> a hard kill leaves a journal that the next run restores
//  15. red: the pre-fix plant leaves a mutated file and no journal after a kill
//  16. pre-existing journal -> honoured and deleted on the next run
//  17. red: the pre-fix plant ignores a journal left by a dead plant
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRATCH = 'G:/Temp/ko-scratch/harness-tools-selftest';

let checks = 0;
let failed = 0;
const lines = [];
const ARMS = [];
function arm(name) {
  ARMS.push(name);
  lines.push(`  arm  ${name}`);
}
function ok(cond, label, detail = '') {
  checks += 1;
  if (cond) lines.push(`  ok   ${label}`);
  else {
    failed += 1;
    lines.push(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function run(args, cwd = ROOT, env = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', env: { ...process.env, ...env },
  });
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function killMidChild(args, marker) {
  const proc = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const wasRunning = existsSync(marker);
  proc.kill('SIGTERM');
  const rc = await new Promise((resolve) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve('timeout'); }, 5000);
    proc.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  return { rc, out, wasRunning };
}

const SUBJECT = path.join(SCRATCH, 'subject.txt');
const JOURNAL = `${SUBJECT}.plant-journal`;
const CHMOD_PROBE = path.join(SCRATCH, 'chmod-probe.mjs');
const KILL_PROBE = path.join(SCRATCH, 'kill-probe.mjs');
const EMIT_PRELOAD = path.join(SCRATCH, 'emit-signal.cjs');
const PREFIX_PLANT = path.join(SCRATCH, 'prefix-ordering-plant.mjs');
const SUBJECT_BODY = 'const ANCHOR = "plant-me";\nconst DUPLICATE = "twice";\nconst DUPLICATE = "twice";\n';

function resetSubject() {
  mkdirSync(SCRATCH, { recursive: true });
  if (existsSync(JOURNAL)) unlinkSync(JOURNAL);
  // A mismatch arm leaves the fixture read-only; make it writable before reuse.
  if (existsSync(SUBJECT)) {
    try { chmodSync(SUBJECT, 0o666); } catch { /* already writable */ }
  }
  writeFileSync(SUBJECT, SUBJECT_BODY, 'utf8');
}
resetSubject();

try {
  // Both falsifiers are FILE probes, never `node -e`: `harness-plant.mjs` and
  // `harness-cwd.mjs` launch their child with `shell: true`, so an inline script
  // reaches cmd.exe where its quotes are mangled (measured 2026-11-27:
  // `expected ',', got '<eof>'`, `MODULE_NOT_FOUND` from a `require` that never
  // arrived). Every real caller in `harness/angulos.tsv` passes `node <file>`.
  const RAN_PROBE = path.join(SCRATCH, 'ran-probe.mjs');
  const SAW_PROBE = path.join(SCRATCH, 'saw-probe.mjs');
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(RAN_PROBE, 'console.log("FALSIFIER-RAN");\n', 'utf8');
  writeFileSync(SAW_PROBE,
    'import { readFileSync } from "node:fs";\n'
    + 'const s = readFileSync(process.argv[2], "utf8");\n'
    + 'console.log(s.includes("MUTANT") ? "CHILD-SAW-MUTANT" : "CHILD-SAW-ORIGINAL");\n', 'utf8');
  // The pre-fix replica isolates the OLD ordering/exit code so each new arm has a
  // measured RED side without mutating the shipped plant or anything tracked.
  writeFileSync(CHMOD_PROBE, 'import { chmodSync } from "node:fs";\nchmodSync(process.argv[2], 0o444);\n', 'utf8');
  writeFileSync(KILL_PROBE,
    'import { writeFileSync } from "node:fs";\n'
    + 'writeFileSync(process.argv[2], "ready");\n'
    + 'setTimeout(() => {}, 1200);\n', 'utf8');
  // Windows delivers cross-process SIGTERM as TerminateProcess, so in-process
  // delivery is the only deterministic way to exercise the handlers themselves.
  writeFileSync(EMIT_PRELOAD,
    'const fs = require("node:fs");\n'
    + 'const write = fs.writeFileSync;\n'
    + 'let fired = false;\n'
    + 'fs.writeFileSync = function (p, data, ...rest) {\n'
    + '  const result = write.call(this, p, data, ...rest);\n'
    + '  if (!fired && String(data).includes("MUTANT")) {\n'
    + '    fired = true;\n'
    + '    const sig = process.env.EMIT_SIGNAL;\n'
    + '    if (sig === "THROW") throw new Error("injected-after-mutation");\n'
    + '    process.emit(sig);\n'
    + '  }\n'
    + '  return result;\n'
    + '};\n', 'utf8');
  writeFileSync(PREFIX_PLANT, [
    "import { spawnSync } from 'node:child_process';",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const [target, from, to, ...cmd] = process.argv.slice(2);",
    "const original = readFileSync(target);",
    "writeFileSync(target, Buffer.from(original.toString('utf8').replace(from, to)));",
    "let status = null;",
    "try {",
    "  const r = spawnSync(cmd[0], cmd.slice(1), { shell: true, encoding: 'utf8' });",
    "  status = r.status === null ? 124 : r.status;",
    "} finally {",
    "  try {",
    "    writeFileSync(target, original);",
    "    console.log('PLANT restored=' + (Buffer.compare(readFileSync(target), original) === 0));",
    "  } catch {",
    "    console.log('PLANT restored=false (MISMATCH)');",
    "  }",
    "}",
    "process.exitCode = status === null ? 124 : status;",
    "",
  ].join('\n'), 'utf8');

  // ---- arm 1: plant, run the falsifier, restore ----------------------------
  arm('1-plant-restore');
  {
    const before = readFileSync(SUBJECT);
    const r = run(['_tools/harness-plant.mjs', '--file', SUBJECT,
      '--from', 'const ANCHOR = "plant-me";', '--to', 'const ANCHOR = "MUTANT";',
      '--', 'node', RAN_PROBE]);
    const after = readFileSync(SUBJECT);
    ok(r.rc === 0, 'plant: the falsifier exit code is propagated as 0', `rc=${r.rc}`);
    ok(/FALSIFIER-RAN/.test(r.out), 'plant: the falsifier actually ran', r.out.trim().slice(-120));
    ok(/PLANT restored=true/.test(r.out), 'plant: printed restored=true', r.out.trim().slice(-160));
    ok(Buffer.compare(before, after) === 0, 'plant: the subject is byte-identical afterwards');
  }

  // ---- arm 2: the mutation was really applied while the child ran ----------
  arm('2-plant-mutation-visible');
  {
    resetSubject();
    const r = run(['_tools/harness-plant.mjs', '--file', SUBJECT,
      '--from', 'const ANCHOR = "plant-me";', '--to', 'const ANCHOR = "MUTANT";',
      '--', 'node', SAW_PROBE, SUBJECT]);
    ok(/CHILD-SAW-MUTANT/.test(r.out), 'plant: the child observed the mutated bytes (a plant that restored before the run would prove nothing)', r.out.trim().slice(-120));
    ok(/PLANT restored=true/.test(r.out), 'plant: restored after the child finished');
    ok(readFileSync(SUBJECT, 'utf8').includes('plant-me'), 'plant: the original anchor is back on disk');
  }

  // ---- arm 3: a stale anchor refuses --------------------------------------
  arm('3-plant-missing-anchor');
  {
    resetSubject();
    const r = run(['_tools/harness-plant.mjs', '--file', SUBJECT,
      '--from', 'AN_ANCHOR_THAT_IS_NOT_THERE',
      '--to', 'x', '--', 'node', '-e', 'console.log(1)']);
    ok(r.rc === 3, 'plant: a missing anchor refuses rc 3 (a stale row is not a red arm)', `rc=${r.rc}`);
    ok(/PLANT REFUSED .*matched 0 time/.test(r.out), 'plant: the refusal names the match count', r.out.trim().slice(-160));
  }

  // ---- arm 4: an ambiguous anchor refuses ---------------------------------
  arm('4-plant-ambiguous-anchor');
  {
    resetSubject();
    const r = run(['_tools/harness-plant.mjs', '--file', SUBJECT,
      '--from', 'const DUPLICATE = "twice";',
      '--to', 'x', '--', 'node', '-e', 'console.log(1)']);
    ok(r.rc === 3, 'plant: an ambiguous anchor refuses rc 3 rather than picking an occurrence', `rc=${r.rc}`);
    ok(/matched 2 time/.test(r.out), 'plant: the refusal reports the 2 matches it saw', r.out.trim().slice(-160));
  }

  // ---- arm 5: an empty --to refuses ---------------------------------------
  arm('5-plant-empty-to');
  {
    resetSubject();
    const r = run(['_tools/harness-plant.mjs', '--file', SUBJECT,
      '--from', 'const ANCHOR = "plant-me";', '--to', '', '--', 'node', '-e', 'console.log(1)']);
    ok(r.rc === 3, 'plant: an empty --to refuses rc 3 (a delete must be asked for by name)', `rc=${r.rc}`);
    ok(/PLANT REFUSED/.test(r.out), 'plant: the refusal is printed');
    ok(readFileSync(SUBJECT, 'utf8').includes('plant-me'), 'plant: the refusal changed nothing on disk');
  }

  // ---- arm 6: no falsifier refuses ----------------------------------------
  arm('6-plant-no-falsifier');
  {
    resetSubject();
    const r = run(['_tools/harness-plant.mjs', '--file', SUBJECT,
      '--from', 'const ANCHOR = "plant-me";', '--to', 'x']);
    ok(r.rc === 3, 'plant: a mutation with no falsifier refuses rc 3', `rc=${r.rc}`);
    ok(/no falsifier given/.test(r.out), 'plant: the refusal says the falsifier is missing');
  }

  // ---- arm 7: a missing cwd refuses ---------------------------------------
  arm('7-cwd-missing-dir');
  {
    const r = run(['_tools/harness-cwd.mjs', 'no-such-directory-xyz', 'node', '-e', 'console.log(1)']);
    ok(r.rc === 2, 'cwd: a missing directory refuses rc 2', `rc=${r.rc}`);
    ok(/HARNESS-CWD REFUSED no such directory: no-such-directory-xyz/.test(r.out), 'cwd: the refusal names the directory', r.out.trim().slice(-120));
  }

  // ---- arm 8: missing args refuse -----------------------------------------
  arm('8-cwd-noargs');
  {
    const r = run(['_tools/harness-cwd.mjs']);
    ok(r.rc === 2, 'cwd: no arguments refuses rc 2', `rc=${r.rc}`);
    ok(/HARNESS-CWD REFUSED usage/.test(r.out), 'cwd: the refusal prints the usage line');
  }

  // ---- arm 9: the child really runs from the declared cwd -----------------
  arm('9-cwd-runs-child');
  {
    // `kick-overlay/manifest.json` exists; from ROOT that relative path does not.
    // A relative read that succeeds only one directory down is the cwd proof, and it
    // needs no mutation at all.
    //
    // The probe lives in a file, never in `node -e`: `harness-cwd.mjs` launches the
    // child with `shell: true`, so an inline `-e` script reaches cmd.exe and its
    // quotes are eaten (measured 2026-11-27: `expected ',', got '<eof>'`, and the
    // same escape losing the `require`/`getBuiltinModule` call entirely). A path
    // with no spaces carries the probe intact, and the RELATIVE read inside it is
    // what proves the working directory.
    const probe = path.join(SCRATCH, 'cwd-probe.mjs');
    writeFileSync(probe, 'import { existsSync } from "node:fs";\n'
      + 'console.log(process.argv[2] + " " + existsSync("manifest.json"));\n', 'utf8');
    const fromRoot = run([probe, 'ROOT_HAS']);
    ok(/ROOT_HAS false/.test(fromRoot.out), 'cwd: the control - `manifest.json` does not resolve from the repo root', fromRoot.out.trim().slice(-80));
    const r = run(['_tools/harness-cwd.mjs', 'kick-overlay', 'node', probe, 'CWD_HAS']);
    ok(r.rc === 0, 'cwd: the child exits 0', `rc=${r.rc}`);
    ok(/CWD_HAS true/.test(r.out), 'cwd: `manifest.json` resolves, so the child ran from kick-overlay', r.out.trim().slice(-120));
  }

  // ---- arm 10: a restore mismatch outranks the child's exit 0 --------------
  arm('10-plant-restore-mismatch-exit4');
  {
    resetSubject();
    // chmod 0o444 on Windows makes the restore write fail with EPERM (measured),
    // while the child still exits 0 -- exactly the case that used to read green.
    const r = run(['_tools/harness-plant.mjs', '--file', SUBJECT,
      '--from', 'const ANCHOR = "plant-me";', '--to', 'const ANCHOR = "MUTANT";',
      '--', 'node', CHMOD_PROBE, SUBJECT]);
    ok(r.rc === 4, 'plant: a restore mismatch outranks a child exit 0 (rc 4)', `rc=${r.rc} out=${r.out.trim().slice(-160)}`);
    ok(/PLANT restored=false/.test(r.out) && /MISMATCH/.test(r.out), 'plant: the mismatch is printed', r.out.trim().slice(-160));
    ok(existsSync(JOURNAL), 'plant: the journal is kept when the restore failed so a later run can recover');
  }

  // ---- arm 11: RED, the old ordering reported mismatch but exited 0 --------
  arm('11-red-prefix-ordering-exit0');
  {
    resetSubject();
    const r = run([PREFIX_PLANT, SUBJECT, 'const ANCHOR = "plant-me";',
      'const ANCHOR = "MUTANT";', 'node', CHMOD_PROBE, SUBJECT]);
    ok(r.rc === 0, 'red: the pre-fix ordering exits 0 despite a printed MISMATCH (the defect)', `rc=${r.rc} out=${r.out.trim().slice(-160)}`);
    ok(/PLANT restored=false/.test(r.out), 'red: the replica really produced a restore mismatch', r.out.trim().slice(-160));
    ok(readFileSync(SUBJECT, 'utf8').includes('MUTANT'), 'red: the subject stays mutated after the failed restore');
  }

  // ---- arm 12: handlers restore on SIGINT/SIGTERM/SIGHUP/throw -------------
  arm('12-plant-signal-handlers-restore');
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'THROW']) {
    resetSubject();
    const r = run(['_tools/harness-plant.mjs', '--file', SUBJECT,
      '--from', 'const ANCHOR = "plant-me";', '--to', 'const ANCHOR = "MUTANT";',
      '--', 'node', RAN_PROBE], ROOT, { NODE_OPTIONS: `--require ${EMIT_PRELOAD}`, EMIT_SIGNAL: sig });
    const label = sig === 'THROW' ? 'uncaughtException' : `signal ${sig}`;
    const line = sig === 'THROW' ? /PLANT uncaughtException/ : new RegExp(`PLANT signal=${sig}`);
    ok(r.rc !== 0, `plant: ${label} exits nonzero`, `rc=${r.rc} out=${r.out.trim().slice(-160)}`);
    ok(line.test(r.out), `plant: ${label} is handled`, r.out.trim().slice(-160));
    ok(readFileSync(SUBJECT, 'utf8') === SUBJECT_BODY, `plant: ${label} restored the exact bytes`);
    ok(!existsSync(JOURNAL), `plant: ${label} removed the journal`);
  }

  // ---- arm 13: RED, no handler means the signal changes nothing -----------
  arm('13-red-no-signal-handler');
  {
    resetSubject();
    const r = run([PREFIX_PLANT, SUBJECT, 'const ANCHOR = "plant-me";',
      'const ANCHOR = "MUTANT";', 'node', RAN_PROBE], ROOT,
    { NODE_OPTIONS: `--require ${EMIT_PRELOAD}`, EMIT_SIGNAL: 'SIGTERM' });
    ok(r.rc === 0, 'red: with no handler an in-process SIGTERM is a no-op and the child rc wins', `rc=${r.rc}`);
    ok(!/PLANT signal=SIGTERM/.test(r.out), 'red: the replica printed no handler line', r.out.trim().slice(-160));
  }

  // ---- arm 14: SIGTERM mid-child survives via the target-derived journal --
  arm('14-plant-sigterm-kill-journal');
  {
    resetSubject();
    const marker = path.join(SCRATCH, 'kill-ready.flag');
    const args = ['_tools/harness-plant.mjs', '--file', SUBJECT,
      '--from', 'const ANCHOR = "plant-me";', '--to', 'const ANCHOR = "MUTANT";',
      '--', 'node', KILL_PROBE, marker];
    const killed = await killMidChild(args, marker);
    ok(killed.wasRunning, 'plant: the falsifier was running when SIGTERM arrived', killed.out.trim().slice(-160));
    const journalled = existsSync(JOURNAL) && readFileSync(JOURNAL, 'utf8') === SUBJECT_BODY;
    const handled = /PLANT signal=SIGTERM/.test(killed.out) && readFileSync(SUBJECT, 'utf8') === SUBJECT_BODY;
    ok(journalled || handled, 'plant: a SIGTERM mid-child restores immediately or leaves a journal with the original bytes', `rc=${killed.rc} out=${killed.out.trim().slice(-160)}`);
    const again = run([args[0], ...args.slice(1, 8), 'node', RAN_PROBE]);
    ok(/PLANT restored-from-journal/.test(again.out), 'plant: the next run honours the journal left by the killed plant', again.out.trim().slice(-160));
    ok(readFileSync(SUBJECT, 'utf8') === SUBJECT_BODY, 'plant: the subject is byte-identical after journal recovery');
    ok(!existsSync(JOURNAL), 'plant: the journal is deleted after a verified restore');
  }

  // ---- arm 15: RED, a kill without a journal leaves the mutant in place ---
  arm('15-red-sigterm-kill-no-journal');
  {
    resetSubject();
    const marker = path.join(SCRATCH, 'red-kill-ready.flag');
    const killed = await killMidChild([PREFIX_PLANT, SUBJECT, 'const ANCHOR = "plant-me";',
      'const ANCHOR = "MUTANT";', 'node', KILL_PROBE, marker], marker);
    ok(killed.wasRunning, 'red: the falsifier was running when SIGTERM arrived', killed.out.trim().slice(-160));
    ok(!existsSync(JOURNAL), 'red: the pre-fix plant writes no journal at all');
    ok(readFileSync(SUBJECT, 'utf8').includes('MUTANT'), 'red: after the kill the pre-fix subject stays mutated');
  }

  // ---- arm 16: a pre-existing journal is replayed on startup -------------
  arm('16-plant-preexisting-journal');
  {
    resetSubject();
    writeFileSync(JOURNAL, SUBJECT_BODY, 'utf8');
    writeFileSync(SUBJECT, SUBJECT_BODY.replace('plant-me', 'MUTANT'), 'utf8');
    const r = run(['_tools/harness-plant.mjs', '--file', SUBJECT,
      '--from', 'const ANCHOR = "plant-me";', '--to', 'const ANCHOR = "MUTANT";',
      '--', 'node', RAN_PROBE]);
    ok(/PLANT restored-from-journal/.test(r.out), 'plant: startup replays the journal before reading the anchor', r.out.trim().slice(-160));
    ok(r.rc === 0, 'plant: the normal plant still succeeds after recovery', `rc=${r.rc} out=${r.out.trim().slice(-160)}`);
    ok(readFileSync(SUBJECT, 'utf8') === SUBJECT_BODY, 'plant: the subject is byte-identical afterwards');
    ok(!existsSync(JOURNAL), 'plant: the replayed journal is deleted');
  }

  // ---- arm 17: RED, the old plant ignores an orphaned journal ------------
  arm('17-red-preexisting-journal-ignored');
  {
    resetSubject();
    writeFileSync(JOURNAL, SUBJECT_BODY, 'utf8');
    writeFileSync(SUBJECT, SUBJECT_BODY.replace('plant-me', 'MUTANT'), 'utf8');
    const r = run([PREFIX_PLANT, SUBJECT, 'const ANCHOR = "plant-me";',
      'const ANCHOR = "MUTANT";', 'node', RAN_PROBE]);
    ok(!/PLANT restored-from-journal/.test(r.out), 'red: the pre-fix plant never replays the orphaned journal', `rc=${r.rc} out=${r.out.trim().slice(-160)}`);
    ok(readFileSync(SUBJECT, 'utf8').includes('MUTANT'), 'red: the mutant stays on disk');
    ok(existsSync(JOURNAL), 'red: the journal stays unread');
  }
} finally {
  // Exact-path cleanup: the directory this test created, nothing else.
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* already gone */ }
}

const EXPECTED_ARMS = 17;
const told = ARMS.length;
const allOk = failed === 0 && told === EXPECTED_ARMS;
for (const line of lines) console.log(line);
if (told !== EXPECTED_ARMS) console.error(`ARMS never entered: expected ${EXPECTED_ARMS}, entered ${told} (${ARMS.join(', ')})`);
console.log(`RESULT ${allOk ? 'PASS' : 'FAIL'} harness-tools checks=${checks} failed=${failed} arms=${told}/${EXPECTED_ARMS}`);
process.exit(allOk ? 0 : 1);
