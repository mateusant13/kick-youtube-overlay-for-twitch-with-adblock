// Grade recorded twins against the tools that read them. No browser, no network.
// Usage: node harness/twins/replay.mjs --twin <id> | --all | --selftest [--json]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CONFIG = join(HERE, 'twins.json');
const STARTED = Date.now();

function argOf(name) {
  const prefix = `--${name}`;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === prefix) return argv[i + 1] ?? null;
    if (argv[i].startsWith(`${prefix}=`)) return argv[i].slice(prefix.length + 1);
  }
  return null;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function loadConfig() {
  try {
    const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
    if (config.schema !== 'revival.twins/v1' || !Array.isArray(config.twins)) {
      throw new Error(`unsupported schema: ${config.schema}`);
    }
    return config;
  } catch (error) {
    console.error(`TWIN CONFIG FAIL reason=${error.message}`);
    process.exit(2);
  }
}

function recordedPath(twin) {
  return isAbsolute(twin.recorded) ? twin.recorded : resolve(ROOT, twin.recorded);
}

// The verdict prefix is part of the contract: only bullets under VERDICT count.
function defectBullets(output) {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((line) => line.startsWith('VERDICT '));
  if (at < 0) return [];
  const bullets = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (!lines[i].startsWith('  - ')) break;
    bullets.push(lines[i]);
  }
  return bullets;
}

function runTool(args) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 12000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function gradeTwin(twin) {
  const t0 = Date.now();
  const result = {
    id: twin.id,
    kind: twin.kind,
    status: 'PASS',
    reason: '',
    defects: 0,
    ms: 0,
    expected_rc: twin.expected_rc,
    observed_rc: null,
    expected_defect_lines: [...(twin.expected_defect_lines || [])],
    observed_defect_lines: [],
    missing_recorded: false,
  };
  const path = recordedPath(twin);
  if (!existsSync(path)) {
    result.status = 'FAIL';
    result.reason = `missing recorded artifact ${twin.recorded}`;
    result.missing_recorded = true;
    result.ms = Date.now() - t0;
    return result;
  }

  let run;
  if (twin.kind === 'ring-replay') {
    run = runTool([join(ROOT, '_tools/ko-adlog-verdict.mjs'), `--file=${path}`, '--episodes=1']);
  } else if (twin.kind === 'suite-golden') {
    run = runTool([join(ROOT, 'kick-overlay/yt-route-test.cjs')]);
  } else {
    result.status = 'FAIL';
    result.reason = `unknown kind ${twin.kind}`;
    result.ms = Date.now() - t0;
    return result;
  }

  const problems = [];
  result.observed_rc = run.status ?? null;
  if (run.error) problems.push(`spawn error ${run.error.message}`);
  if (run.status !== twin.expected_rc) {
    problems.push(`rc observed=${run.status} expected=${twin.expected_rc}`);
  }
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const absent = (twin.expected_lines || []).filter((line) => !output.includes(line));
  if (absent.length) problems.push(`expected line missing=${JSON.stringify(absent)}`);

  if (twin.kind === 'ring-replay') {
    const observed = defectBullets(output);
    result.observed_defect_lines = observed;
    result.defects = observed.length;
    const expectedSet = new Set(result.expected_defect_lines);
    const observedSet = new Set(observed);
    const missing = [...expectedSet].filter((line) => !observedSet.has(line));
    const added = [...observedSet].filter((line) => !expectedSet.has(line));
    if (missing.length || added.length) {
      problems.push(`defect set mismatch missing=${JSON.stringify(missing)} new=${JSON.stringify(added)}`);
    }
  } else {
    const goldenLines = readFileSync(path, 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.trim() !== '');
    const missingGolden = goldenLines.filter((line) => !output.includes(line));
    if (missingGolden.length) problems.push(`golden line missing=${JSON.stringify(missingGolden)}`);
  }

  result.ms = Date.now() - t0;
  if (problems.length) {
    result.status = 'FAIL';
    result.reason = problems.join('; ');
  }
  return result;
}

function selftest(config) {
  const twin = config.twins.find((item) => item.kind === 'ring-replay');
  if (!twin) {
    console.log('SELFTEST FAIL reason=no ring-replay twin');
    process.exit(1);
  }
  const baseline = gradeTwin(twin);
  if (baseline.status !== 'PASS') {
    console.log(`SELFTEST FAIL reason=baseline ${baseline.reason}`);
    process.exit(1);
  }

  const corrupted = {
    ...twin,
    expected_defect_lines: twin.expected_defect_lines.map((line, i) =>
      i === 0 ? `${line} [corrupted]` : line),
  };
  const armA = gradeTwin(corrupted);
  const aOk = armA.status === 'FAIL' && armA.reason.includes('defect set mismatch');
  console.log(`SELFTEST ARM corrupt-expected ${armA.status} reason=${armA.reason}`);

  const tempDir = mkdtempSync(join(tmpdir(), 'twins-selftest-'));
  let armB;
  try {
    const recorded = JSON.parse(readFileSync(recordedPath(twin), 'utf8'));
    const shortPath = join(tempDir, 'truncated.json');
    writeFileSync(shortPath, `${JSON.stringify({ ...recorded, log: recorded.log.slice(0, 5) })}\n`, 'utf8');
    armB = gradeTwin({ ...twin, recorded: shortPath });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  const bOk = armB.status === 'FAIL';
  console.log(`SELFTEST ARM truncated-log ${armB.status} reason=${armB.reason}`);

  if (!aOk || !bOk) {
    console.log(`SELFTEST FAIL reason=arms corrupt-expected=${aOk} truncated-log=${bOk}`);
    process.exit(1);
  }
  console.log('SELFTEST PASS arms=2');
}

// A corrupt arm is the grader's own two-direction proof: grade a MUTATED copy of
// the recorded artifact and require the grader to FAIL. Without it a green twin
// row cannot distinguish "the product is right" from "the grader never looked".
function corruptTwin(twin, tempDir) {
  const source = recordedPath(twin);
  if (!existsSync(source)) {
    return { id: twin.id, status: 'PASS', reason: 'nothing to corrupt (no recording)', ms: 0 };
  }
  const t0 = Date.now();
  const mutated = join(tempDir, `${twin.id}.corrupt`);
  if (twin.kind === 'ring-replay') {
    const recorded = JSON.parse(readFileSync(source, 'utf8'));
    writeFileSync(mutated, `${JSON.stringify({ ...recorded, log: recorded.log.slice(0, 5) })}\n`, 'utf8');
  } else {
    // A golden line the tool cannot print is the same corruption a stale golden
    // would be: the grader must notice the absence, not shrug at it.
    writeFileSync(mutated, `${readFileSync(source, 'utf8').trimEnd()}\nPASS impossible golden line\n`, 'utf8');
  }
  const arm = gradeTwin({ ...twin, recorded: mutated });
  const ok = arm.status === 'FAIL';
  return {
    id: twin.id,
    status: ok ? 'PASS' : 'FAIL',
    reason: ok ? `grader caught the corrupt artifact (${arm.reason.slice(0, 80)})` : 'grader passed a corrupt artifact',
    ms: Date.now() - t0,
  };
}

function main() {
  const config = loadConfig();
  if (flag('selftest')) {
    selftest(config);
    return;
  }
  const id = argOf('twin');
  const all = flag('all');
  if (flag('corrupt')) {
    const chosen = all || !id ? config.twins : config.twins.filter((twin) => twin.id === id);
    if (!chosen.length) {
      console.log(`TWIN CORRUPT FAIL reason=unknown twin id=${id}`);
      process.exit(2);
    }
    const tempDir = mkdtempSync(join(tmpdir(), 'twins-corrupt-'));
    let arms;
    try {
      arms = chosen.map((twin) => corruptTwin(twin, tempDir));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
    for (const arm of arms) {
      console.log(`TWIN CORRUPT ${arm.status} ${arm.id} reason=${arm.reason}`);
    }
    const bad = arms.filter((arm) => arm.status !== 'PASS').length;
    if (bad) {
      console.log(`TWIN CORRUPT FAIL arms=${arms.length} failed=${bad}`);
      process.exit(1);
    }
    console.log(`TWIN CORRUPT PASS arms=${arms.length}`);
    return;
  }
  if (!all && !id) {
    console.log('TWIN USAGE node harness/twins/replay.mjs --twin <id> | --all | --selftest [--json]');
    process.exit(2);
  }
  const chosen = all ? config.twins : config.twins.filter((twin) => twin.id === id);
  const results = chosen.map(gradeTwin);
  if (!all && chosen.length === 0) {
    results.push({
      id, kind: '-', status: 'FAIL', reason: 'unknown twin', defects: 0, ms: 0,
      expected_rc: null, observed_rc: null, expected_defect_lines: [],
      observed_defect_lines: [], missing_recorded: false,
    });
  }

  const failed = results.filter((result) => result.status !== 'PASS').length;
  const ms = Date.now() - STARTED;
  const verdict = failed ? 'FAIL' : 'PASS';
  if (flag('json')) {
    console.log(JSON.stringify({
      schema: 'revival.twins.result/v1',
      mode: all ? 'all' : 'twin',
      result: verdict,
      twins: results,
      failed,
      ms,
    }));
  } else {
    for (const result of results) {
      if (result.status === 'PASS') {
        console.log(`TWIN PASS ${result.id} kind=${result.kind} defects=${result.defects} ms=${result.ms}`);
      } else {
        console.log(`TWIN FAIL ${result.id} reason=${result.reason}`);
      }
    }
    console.log(`TWIN RESULT ${verdict} twins=${results.length} failed=${failed} ms=${ms}`);
  }
  if (results.some((result) => result.missing_recorded)) process.exit(2);
  process.exit(failed ? 1 : 0);
}

main();
