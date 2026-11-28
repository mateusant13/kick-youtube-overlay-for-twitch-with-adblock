// ---- 12. published receipts name the build that produced their numbers -----------
// Consumer side of the fleet rule (seat DMs dm-1ab8ac747808dd73e77b, dm-0c89df188e298a8f1d5c):
// the detector set lives in the installed codeintel, so a receipt without `codeintel X.Y.Z` and
// `sha=` cannot be compared with today's tool. The predicate is checked on the real corpus AND on
// a copy of that corpus with its build lines removed, so the check cannot pass by accepting
// everything.
import { RECEIPTS, receiptProblem, strippedOfBuild } from '../receipt-build.mjs';

export const receiptChecks = [
  {
    name: 'receipt-build',
    run(ctx) {
      const problems = [];
      for (const rel of RECEIPTS) {
        const text = ctx.read(rel);
        const problem = receiptProblem(text);
        if (problem) problems.push(`${rel}: ${problem}`);
        // Negative arm from the same bytes: the predicate must reject what it just accepted once
        // the identity is gone. A green here without this arm would be a predicate that is blind.
        if (receiptProblem(strippedOfBuild(text)) === null) {
          problems.push(`${rel}: the predicate still accepts the receipt with its build stripped`);
        }
      }
      ctx.assert(problems.length === 0, problems.join('\n'));
      return `${RECEIPTS.length} receipt(s) carry codeintel version + sha, and each is refused once stripped of them`;
    },
  },
];
