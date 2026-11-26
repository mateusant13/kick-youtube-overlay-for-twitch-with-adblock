// Turn one finished ko-replica run directory into a recorded twin.
// The recording is the ring rows the replica actually wrote, not a re-creation.
// Usage: node harness/twins/capture.mjs --run <absolute run dir> --id <twin id>
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDINGS = join(HERE, 'recordings');

function fail(message) {
  console.error(`CAPTURE FAIL reason=${message}`);
  process.exit(2);
}

function argOf(name) {
  const prefix = `--${name}`;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === prefix) return argv[i + 1] ?? null;
    if (token.startsWith(`${prefix}=`)) return token.slice(prefix.length + 1);
  }
  return null;
}

const run = argOf('run');
const id = argOf('id');
if (!run || !id) {
  fail('usage: --run <absolute ko-replica run dir> --id <twin id>');
}
if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) fail(`bad twin id: ${id}`);
const sourceRun = run.replace(/\\/g, '/');
if (!isAbsolute(sourceRun)) fail(`--run must be absolute: ${run}`);

let dir;
try {
  dir = statSync(sourceRun);
} catch {
  fail(`run dir missing: ${sourceRun}`);
}
if (!dir.isDirectory()) fail(`run path is not a directory: ${sourceRun}`);

let report;
try {
  report = JSON.parse(readFileSync(join(sourceRun, 'report.json'), 'utf8'));
} catch (error) {
  fail(`cannot read report.json in ${sourceRun}: ${error.message}`);
}
if (!report || !Array.isArray(report.rows) || report.rows.length === 0) {
  fail(`rows missing or empty in ${sourceRun}/report.json`);
}

const recording = {
  recorded_at: new Date().toISOString(),
  source_run: sourceRun,
  scenario: typeof report.scenario === 'string' ? report.scenario : null,
  build: typeof report.build === 'string' ? report.build : null,
  log: report.rows,
};

mkdirSync(RECORDINGS, { recursive: true });
const target = join(RECORDINGS, `${id}.json`);
const bytes = `${JSON.stringify(recording)}\n`;
writeFileSync(target, bytes, 'utf8');
console.log(
  `CAPTURE PASS id=${id} rows=${recording.log.length} bytes=${Buffer.byteLength(bytes)} -> harness/twins/recordings/${id}.json`,
);
