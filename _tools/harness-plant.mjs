#!/usr/bin/env node
// Plant one pre-fix mutation in a shipped file, run a falsifier against it, and
// restore the exact bytes -- the missing half of a two-direction harness arm.
//
// WHY THIS EXISTS. `harness/angles.tsv` carries a `neg` cell per row ("write the
// adverse arm first: mutate the owning line and prove the check turns red"). The
// matrix readers of record (`_packs/task/project-harness/scripts/harness_run.py`)
// take that cell as a COMMAND and require its output to stop matching `expect`.
// MEASURED 2026-11-27 on this repo and on `I:/!watcher`: both matrices were written
// with an expected reference in that cell ("remove AD_POD_MAX_MS", "TICKS 0"), so the
// runner executed prose, got rc=127 with empty output, and printed
// `red arm refused as designed (neg rc=127)` -- a two-direction green over a row whose
// adverse arm never ran. The verdict was not wrong about the output; it was wrong
// about what it had proved.
//
// This tool is the command those cells were trying to be. It mutates ONE exact string
// in place, runs the given falsifier, and restores the file in a `finally` (verified by
// byte comparison, printed on the last line). An anchor that no longer exists is a
// REFUSAL (exit 3): a stale mutation is not a passing red arm.
//
//   node _tools/harness-plant.mjs --from "const AD_POD_MAX_MS = 60000;" \
//        --to "const AD_POD_MAX_MS = 180000;" -- node kick-overlay/ad-detect-test.cjs
//
// Defaults --file kick-overlay/twitch-adblock.js. Other flags:
//   --file <rel>        file to mutate (repo-relative)
//   --timeout-ms <n>    child kill deadline, default 300000
//   --dry-run           print the anchor and exit, mutate nothing
//
// Exit codes: the child's, so a falsifier that legitimately fails is visible; 3 when
// the anchor is missing; 4 when the restore did not reproduce the original bytes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep >= 0 ? argv.slice(0, sep) : argv;
const child = sep >= 0 ? argv.slice(sep + 1) : [];

function flag(name, fallback) {
  const i = own.indexOf(name);
  return i >= 0 && own[i + 1] !== undefined ? own[i + 1] : fallback;
}

const file = flag('--file', 'kick-overlay/twitch-adblock.js');
const from = flag('--from', '');
const to = flag('--to', '');
const timeoutMs = Number(flag('--timeout-ms', '300000'));
// Several suites resolve `__dirname` relatives from the working directory
// (`content-fix-test.cjs` reads `./manifest.json`, `route-gate-test.cjs` reads
// `./content.js`), so a plant must run its falsifier from the cwd that suite
// declares instead of guessing one.
const childCwd = path.join(ROOT, flag('--cwd', '.'));
const dryRun = own.includes('--dry-run');
// An ABSOLUTE `--file` is used as given. Without this the only plantable subject was a
// file inside the checkout, so any selftest that proved "the bytes come back" had to
// mutate TRACKED product code - one kill between write and restore left the tree dirty
// with a mutant nobody planted on purpose. A fixture on `G:/Temp` proves the same
// restore contract with nothing at risk.
const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
// The journal is derived from THIS target, never a shared temp name: two plants
// in flight (or two fixtures) must never trade restore bytes.
const journal = `${abs}.plant-journal`;

function refuse(msg) {
  console.log(`PLANT REFUSED ${msg}`);
  process.exit(3);
}
// Recovery runs before any anchor is read: a previous plant that died between
// mutation and restore left its original bytes here. SIGKILL cannot be handled
// in-process, so this startup replay is the only guarantee for that case.
if (existsSync(journal)) {
  try {
    const saved = readFileSync(journal);
    writeFileSync(abs, saved);
    if (Buffer.compare(readFileSync(abs), saved) !== 0) throw new Error('restore did not reproduce the journal bytes');
    rmSync(journal);
    console.log(`PLANT restored-from-journal file=${file}`);
  } catch (error) {
    console.log(`PLANT restored-from-journal file=${file} FAILED error=${error.message}`);
    process.exit(4);
  }
}

if (!from) refuse('--from is empty: a mutation with no anchor cannot be planted');
if (!child.length) refuse('no falsifier given after `--`');
if (!dryRun && !to && from) refuse('--to is empty: the mutation would only delete the anchor');

let original;
try {
  original = readFileSync(abs);
} catch (error) {
  refuse(`cannot read ${file} (resolved ${abs}): ${error.message}`);
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const text = original.toString('utf8');
const hits = text.split(from).length - 1;
if (hits !== 1) {
  // 0 = the anchor moved (a stale row); >1 = ambiguous, so which defect was planted
  // would depend on split order -- both are refusals, never a guess.
  refuse(`anchor ${JSON.stringify(from)} matched ${hits} time(s) in ${file}; exactly one is required`);
}
if (dryRun) {
  console.log(`PLANT DRY-RUN file=${file} hits=1 sha=${sha(original)}`);
  process.exit(0);
}

const mutated = Buffer.from(text.replace(from, to), 'utf8');

function clearJournal() {
  try {
    if (existsSync(journal)) rmSync(journal);
  } catch (error) {
    console.log(`PLANT journal-remove-failed file=${file} error=${error.message}`);
  }
}

function restoreAndExit(bytes, code, label) {
  let restored = false;
  try {
    writeFileSync(abs, bytes);
    restored = Buffer.compare(readFileSync(abs), bytes) === 0;
    if (restored) clearJournal();
  } catch (error) {
    console.log(`PLANT restore-failed file=${file} label=${label} error=${error.message}`);
  }
  console.log(`PLANT restored=${restored} file=${file} sha=${sha(bytes)}${restored ? '' : ' (MISMATCH)'}`);
  process.exit(code);
}

// Registered BEFORE the mutation write. spawnSync blocks the event loop, so a
// signal delivered by another process on Windows (unconditional TerminateProcess)
// is recovered by the journal on the next run; an in-process signal or a POSIX
// delivery reaches these handlers and restores immediately.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    console.log(`PLANT signal=${sig} file=${file}`);
    restoreAndExit(original, sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 129, sig);
  });
}
process.on('uncaughtException', (error) => {
  console.error(`PLANT uncaughtException file=${file} error=${error.message}`);
  restoreAndExit(original, 1, 'uncaughtException');
});

writeFileSync(journal, original);
writeFileSync(abs, mutated);
let status = null;
let mismatch = false;
try {
  const r = spawnSync(child[0], child.slice(1), {
    cwd: childCwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  status = r.status === null ? 124 : r.status;
} finally {
  let restored = false;
  try {
    writeFileSync(abs, original);
    restored = Buffer.compare(readFileSync(abs), original) === 0;
  } catch (error) {
    console.log(`PLANT restore-failed file=${file} error=${error.message}`);
  }
  mismatch = !restored;
  console.log(`PLANT restored=${restored} file=${file} sha=${sha(original)}${restored ? '' : ' (MISMATCH)'}`);
  if (restored) clearJournal();
}
// A restore mismatch outranks the child status: a corrupted tree must never be
// reported green just because the falsifier happened to exit 0.
process.exitCode = mismatch ? 4 : (status === null ? 124 : status);
