#!/usr/bin/env node
// Run one command from a declared subdirectory of the repo.
//
// WHY THIS EXISTS. `harness/angulos.tsv` cells are executed by the matrix reader
// from the repo root, but several suites resolve their inputs from the working
// directory: `kick-overlay/content-fix-test.cjs` reads `./manifest.json` and
// `kick-overlay/route-gate-test.cjs` reads `./content.js`, so from the root they
// die with ENOENT on a file that exists one directory down. Quoting the path does
// not help -- the suite, not the caller, decides. This launcher is the cwd a row
// declares, named once, so the matrix stays a table of commands.
//
//   node _tools/harness-cwd.mjs kick-overlay node content-fix-test.cjs
//
// Usage: node _tools/harness-cwd.mjs <cwd-rel-to-repo> <cmd> [args...]
// Exit: the child's status (127 when it cannot launch, 2 on a missing argument).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dir = argv[0];
const child = argv.slice(1);

if (!dir || !child.length) {
  console.log('HARNESS-CWD REFUSED usage: node _tools/harness-cwd.mjs <cwd-rel-to-repo> <cmd> [args...]');
  process.exit(2);
}
const cwd = path.join(ROOT, dir);
if (!existsSync(cwd)) {
  console.log(`HARNESS-CWD REFUSED no such directory: ${dir}`);
  process.exit(2);
}

const run = spawnSync(child[0], child.slice(1), {
  cwd,
  shell: true,
  encoding: 'utf8',
  timeout: 300000,
  killSignal: 'SIGKILL',
  maxBuffer: 64 * 1024 * 1024,
});
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
process.exit(run.status === null ? 124 : run.status);
