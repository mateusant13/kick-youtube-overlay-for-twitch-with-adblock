// Receipt: the machine artifact the gate exists to produce.
//
// `prepareReceipt` is called after the ordered checks and before
// `verified-artifacts`, because that check audits the arm artifacts this run
// just wrote. `finalizeReceipt` computes the verdict, writes the JSON + markdown
// receipt, and prints the RESULT line with the process status.
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PRODUCT_JS } from './product.mjs';
import { MEASURED_LIVE, notMeasured } from './receipt-data.mjs';
import { writeArmArtifacts } from './arms.mjs';
import { isVerifiedClaim } from './bug-state.mjs';

export function prepareReceipt(ctx) {
  const { state, ROOT } = ctx;
  const head = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { timeout: 60000, killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  const gitHead = String(head.stdout || '').trim() || 'unknown';
  state.gitHead = gitHead;
  state.unverified = state.ledger.bugs.filter((b) => b.state === 'fixed' && !isVerifiedClaim(b));
  // LIVE PENDING is narrower than "carries an artifact": a `verified` row already
  // had its live validation, so only `arm-verified` still owes the owner run.
  state.livePending = state.ledger.bugs.filter((b) => b.state === 'arm-verified');
  state.notMeasured = notMeasured(ROOT);

  const sourceSha = {};
  for (const rel of PRODUCT_JS) sourceSha[rel] = ctx.sha256(ctx.read(rel));

  const payload = {
    schema: 1,
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - state.started,
    git_head: gitHead,
    version: state.manifest ? state.manifest.version : null,
    result: 'PASS',
    checks: state.results,
    source_sha256: sourceSha,
    bugs: state.ledger.bugs,
    not_measured: state.notMeasured,
    measured_live: MEASURED_LIVE,
  };
  state.payload = payload;

  mkdirSync(state.evidenceDir, { recursive: true });
  writeArmArtifacts(ctx);
  return payload;
}

// A throw outside `runCheck` — in `prepareReceipt` (a missing PRODUCT_JS file,
// `writeArmArtifacts`) or in the receipt writers — aborts before
// `finalizeReceipt`, so the PREVIOUS receipt stays on disk. A reader then sees
// `result: PASS` beside a crashed run: the one artifact the gate must never
// leave behind. This writes a FAIL receipt from whatever state exists.
export function crashReceipt(ctx, error) {
  const { state } = ctx;
  const detail = String(error && error.stack ? error.stack : error);
  const results = state.results.concat([{ name: 'gate-crashed', status: 'FAIL', detail }]);
  const payload = {
    schema: 1,
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - state.started,
    git_head: state.gitHead || 'unknown',
    version: state.manifest ? state.manifest.version : null,
    result: 'FAIL',
    checks: results,
    source_sha256: {},
    bugs: state.ledger && state.ledger.bugs ? state.ledger.bugs : [],
    not_measured: state.notMeasured || [],
    measured_live: MEASURED_LIVE,
  };
  try {
    mkdirSync(state.evidenceDir, { recursive: true });
    writeFileSync(path.join(state.evidenceDir, 'ko-verify-latest.json'), JSON.stringify(payload, null, 2) + '\n');
    const lines = [
      '# KO fast verification receipt',
      '',
      `- generated: ${payload.generated_at}`,
      `- git: ${payload.git_head}`,
      `- extension: ${payload.version}`,
      '- result: **FAIL**',
      `- elapsed: ${payload.elapsed_ms} ms`,
      '',
      '## Checks',
      '',
      '| Check | Status | Detail |',
      '| --- | --- | --- |',
      ...results.map((r) => `| ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, '\\|')} |`),
      '',
      'The gate aborted before it could finalize. A throw outside a check body',
      'would otherwise leave the previous receipt on disk as a stale PASS, so this',
      'receipt is written by the crash path itself and the exit code is 1.',
      '',
    ];
    writeFileSync(path.join(state.evidenceDir, 'ko-verify-latest.md'), lines.join('\n'));
  } catch (writeError) {
    console.error('FAIL gate-crashed  could not write a receipt:', writeError && writeError.message);
  }
  console.error(`FAIL gate-crashed  ${detail.split('\n')[0]}`);
  console.log(`RESULT FAIL  checks=${results.length}  failed=${results.filter((r) => r.status === 'FAIL').length}`);
  console.log('  - gate-crashed: a throw outside the check bodies aborted the run before finalize');
  process.exitCode = 1;
}

export function finalizeReceipt(ctx) {
  const { state, ROOT } = ctx;
  const { payload } = state;
  const results = state.results;
  const failed = results.filter((r) => r.status === 'FAIL');
  payload.result = failed.length ? 'FAIL' : 'PASS';
  writeFileSync(path.join(state.evidenceDir, 'ko-verify-latest.json'), JSON.stringify(payload, null, 2) + '\n');

  const lines = [
    '# KO fast verification receipt',
    '',
    `- generated: ${payload.generated_at}`,
    `- git: ${state.gitHead}`,
    `- extension: ${payload.version}`,
    `- result: **${payload.result}**`,
    `- elapsed: ${payload.elapsed_ms} ms`,
    '',
    '## Checks',
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, '\\|')} |`),
    '',
    '## Negative arms (machine files)',
    '',
    ...(state.armArtifacts.length
      ? state.armArtifacts.map((a) =>
          a.check === 'reachability'
            ? `- ${a.id}: ${a.path} — reachability ${a.status}, recorded ${a.age_days} day(s) ago, newer than the last change to its source (browser run, not regenerated by this gate)`
            : `- ${a.id}: ${a.path} — ${a.check} ${a.status}, RED/mutation line present=${a.expected_red}`,
        )
      : ['- none']),
    '',
    '## Bugs',
    '',
    ...(state.ledger.bugs.length
      ? state.ledger.bugs.map(
          (b) =>
            `- **${b.id}** ${b.title}: state=\`${b.state}\`, verified=${b.verified === true ? 'true' : 'false'}${b.arms_artifact ? `, arms: ${b.arms_artifact}` : ''}${b.verified_by ? `, verifier: ${b.verified_by}` : ''}${b.owner_validation ? `, owner validation: ${b.owner_validation}` : ''}${b.next ? `, next: ${b.next}` : ''}`,
        )
      : ['- none']),
    '',
    '## Measured live (not by this static gate)',
    '',
    ...(MEASURED_LIVE.length ? MEASURED_LIVE.map((item) => `- ${item}`) : ['- none recorded']),
    '',
    '## NOT MEASURED',
    '',
    ...state.notMeasured.map((item) => `- ${item}`),
    '',
    'This receipt is generated by `_tools/ko-verify.mjs`. It proves the static',
    'checks above and the negative arms that were actually executed. It does not',
    'prove runtime behavior in the owner Chrome.',
    '',
  ];
  writeFileSync(path.join(state.evidenceDir, 'ko-verify-latest.md'), lines.join('\n'));

  console.log('');
  if (state.unverified.length) {
    console.log('='.repeat(64));
    console.log(`FIXED, NOT VERIFIED: ${state.unverified.map((b) => b.id).join(', ')}`);
    console.log('='.repeat(64));
    console.log('');
  }
  if (state.livePending.length) {
    console.log(
      `ARM-VERIFIED, LIVE PENDING: ${state.livePending.map((b) => `${b.id} (${b.owner_validation})`).join('; ')}`,
    );
  }
  console.log(`RESULT ${payload.result}  checks=${results.length}  failed=${failed.length}`);
  console.log(`RECEIPT ${path.relative(ROOT, path.join(state.evidenceDir, 'ko-verify-latest.md'))}`);
  console.log(`NOT MEASURED ${state.notMeasured.length} item(s); see the receipt`);
  if (failed.length) {
    for (const r of failed) console.log(`  - ${r.name}: ${r.detail}`);
    process.exitCode = 1;
  }
}
