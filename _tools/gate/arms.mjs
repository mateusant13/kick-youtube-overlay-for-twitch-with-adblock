// Per-bug arm artifacts.
//
// A bug is only called verified when its negative arm left a machine artifact
// in _evidence/. Each file carries the command, the source hash that was
// exercised, the RED/mutation lines the harness printed and its full output.
// A check that threw before capturing leaves no artifact: a missing artifact is
// visible in arm_artifacts, while a fabricated one would not be.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const ARM_SOURCES = {
  'KO-20261023-01': ['kick-overlay/twitch-adblock.js'],
  'KO-20261026-04': ['kick-overlay/content.js'],
  'KO-20261027-01': ['kick-overlay/twitch-adblock.js'],
};

export function writeArmArtifacts(ctx) {
  const { state } = ctx;
  const { payload } = state;
  const armArtifacts = state.armArtifacts;
  for (const [id, sources] of Object.entries(ARM_SOURCES)) {
    const cap = state.capturedArms[id];
    if (!cap) continue;
    const out = `${cap.r.stdout || ''}${cap.r.stderr || ''}`;
    const verdict = state.results.find((r) => r.name === cap.check);
    const arms = out
      .split(/\r?\n/)
      .filter((line) => /\bRED\b|mutation|EXPECTED-RED/.test(line))
      .map((line) => line.trim());
    const body = [
      `# ${id} — executed arms`,
      '',
      `- generated: ${payload.generated_at}`,
      `- git: ${state.gitHead}`,
      `- extension: ${payload.version}`,
      `- command: node ${cap.rel}  (cwd kick-overlay)`,
      `- check: ${cap.check} -> ${verdict ? verdict.status : 'MISSING'}, exit=${cap.r.status}`,
      ...sources.map((rel) => `- source: ${rel} sha256=${ctx.sha256(ctx.read(rel))}`),
      '',
      '## arm lines (extracted from the captured output)',
      '',
      ...(arms.length ? arms.map((line) => `- ${line}`) : ['- none matched: the negative arm did not print']),
      '',
      '## captured output',
      '',
      '```',
      out.trimEnd(),
      '```',
      '',
      'EXPECTED-RED is a control, not a product failure: the pre-fix mutation has to',
      'fail at the detector that names the defect, which is what the RED line above',
      'reports. A green file with no RED line means the control did not fire.',
      '',
    ].join('\n');
    const rel = path.join('_evidence', `${id}-arms.md`);
    writeFileSync(path.join(ctx.ROOT, rel), body);
    armArtifacts.push({
      id,
      path: rel.split(path.sep).join('/'),
      check: cap.check,
      status: verdict ? verdict.status : 'MISSING',
      expected_red: arms.length > 0,
    });
  }
  payload.arm_artifacts = armArtifacts;
}
