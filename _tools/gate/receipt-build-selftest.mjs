// Two-way arms for the receipt predicate. A predicate that accepts everything is a false green,
// so every "passes" arm here has a twin that must be refused.
import { receiptProblem, strippedOfBuild } from './receipt-build.mjs';

let checks = 0;
let failed = 0;
const arm = (name, ok, detail = '') => {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`);
};

const good = [
  'codeintel 14.0.0 root=H:\\codeintel-worktrees\\x sha=d552474de514 branch=b dist=consultgpt',
  'verdict=partial total=25 cannot_measure=259',
  'population_counts = {scope: 65, outside-scope: 0, scratch: 0}',
].join('\n');

arm('a build-pinned receipt with counts passes', receiptProblem(good) === null, String(receiptProblem(good)));

const noSha = good.replace(/sha=[0-9a-f]{7,40}\s?/, '');
arm('the same receipt without sha is refused', receiptProblem(noSha) !== null, String(receiptProblem(noSha)));

const noVersion = good.split('\n').filter((line) => !/codeintel\s+\d/.test(line)).join('\n');
arm('a receipt with no `codeintel X.Y.Z` is refused', receiptProblem(noVersion) !== null, String(receiptProblem(noVersion)));

const noCounts = good.replace(/population_counts.*/, 'the population is the JS surface');
arm(
  'a receipt that mentions a population without counts is refused',
  receiptProblem(`${noCounts}\npopulacao JS: 113 arquivos`) !== null,
  String(receiptProblem(`${noCounts}\npopulacao JS: 113 arquivos`)),
);

arm('empty text is refused', receiptProblem('') !== null, String(receiptProblem('')));
arm('strippedOfBuild removes the identity it is built from', !/sha=/.test(strippedOfBuild(good)));

// The real corpus, both ways: every published receipt must pass, and its own stripped copy must fail.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RECEIPTS } from './receipt-build.mjs';

const root = path.resolve(import.meta.dirname, '../..');
for (const rel of RECEIPTS) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) {
    arm(`${rel} exists`, false, 'missing');
    continue;
  }
  const text = readFileSync(abs, 'utf8');
  const problem = receiptProblem(text);
  arm(`${rel} passes its own predicate`, problem === null, String(problem));
  arm(`${rel} is refused once its build is stripped`, receiptProblem(strippedOfBuild(text)) !== null);
}

console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} receipt-build-selftest checks=${checks} failed=${failed}`);
process.exit(failed ? 1 : 0);
