#!/usr/bin/env node
// ARMS FOR THE TWO HARNESS TOOLS THE MATRIX RUNS.
//
// MEASURED 2026-11-27: `_tools/harness-plant.mjs` and `_tools/harness-cwd.mjs` were
// invoked by NO gate check. They appeared only as data commands inside
// `harness/angles.tsv`, so the two tools every red matrix arm depends on could break
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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

function run(args, cwd = ROOT) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const SUBJECT = path.join(SCRATCH, 'subject.txt');
const SUBJECT_BODY = 'const ANCHOR = "plant-me";\nconst DUPLICATE = "twice";\nconst DUPLICATE = "twice";\n';

function resetSubject() {
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(SUBJECT, SUBJECT_BODY, 'utf8');
}
resetSubject();

try {
  // Both falsifiers are FILE probes, never `node -e`: `harness-plant.mjs` and
  // `harness-cwd.mjs` launch their child with `shell: true`, so an inline script
  // reaches cmd.exe where its quotes are mangled (measured 2026-11-27:
  // `expected ',', got '<eof>'`, `MODULE_NOT_FOUND` from a `require` that never
  // arrived). Every real caller in `harness/angles.tsv` passes `node <file>`.
  const RAN_PROBE = path.join(SCRATCH, 'ran-probe.mjs');
  const SAW_PROBE = path.join(SCRATCH, 'saw-probe.mjs');
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(RAN_PROBE, 'console.log("FALSIFIER-RAN");\n', 'utf8');
  writeFileSync(SAW_PROBE,
    'import { readFileSync } from "node:fs";\n'
    + 'const s = readFileSync(process.argv[2], "utf8");\n'
    + 'console.log(s.includes("MUTANT") ? "CHILD-SAW-MUTANT" : "CHILD-SAW-ORIGINAL");\n', 'utf8');

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
} finally {
  // Exact-path cleanup: the directory this test created, nothing else.
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* already gone */ }
}

const EXPECTED_ARMS = 9;
const told = ARMS.length;
const allOk = failed === 0 && told === EXPECTED_ARMS;
for (const line of lines) console.log(line);
if (told !== EXPECTED_ARMS) console.error(`ARMS never entered: expected ${EXPECTED_ARMS}, entered ${told} (${ARMS.join(', ')})`);
console.log(`RESULT ${allOk ? 'PASS' : 'FAIL'} harness-tools checks=${checks} failed=${failed} arms=${told}/${EXPECTED_ARMS}`);
process.exit(allOk ? 0 : 1);
