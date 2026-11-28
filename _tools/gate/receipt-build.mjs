// A verdict without the build that produced it is CANNOT-COMPARE.
//
// MEASURED 2026-11-28: the same argv against the same tree returned
// `verdict=pass total=18 cannot_measure=0` on one install and
// `verdict=partial total=25 cannot_measure=259` on the next, because the detector set lives in
// the INSTALLED codeintel, not in this repo. Seat DM `dm-1ab8ac747808dd73e77b` reproduced it;
// DM `dm-0c89df188e298a8f1d5c` refused the paragraph-only fix (0 of codeintel's own 234 receipts
// carry a build) and asked for a machine refusal. This module is that refusal, on the consumer side:
// `codeintel` will stamp `build` in its payload later; until then a receipt that cannot name the
// build that produced its numbers is refused here, by the gate, not by a reviewer's memory.

export const BUILD_RE = /\bsha=[0-9a-f]{7,40}\b/;
export const VERSION_RE = /codeintel\s+\d+\.\d+\.\d+/;
export const POPULATION_RE = /population_counts/;

// Receipts this repo publishes about codeintel. A new one is added here, not discovered by glob,
// so a receipt that moves or is renamed fails loudly instead of quietly leaving the population.
export const RECEIPTS = ['docs/A11-CODEINTEL-RECEIPT.md', 'revival/codeintel-full-recibo.md'];

/**
 * Why a receipt cannot be compared, or null when it can.
 * Both directions matter: a predicate that accepts everything is a false green, so the selftest
 * strips the build line from the real text and requires a refusal.
 */
export function receiptProblem(text) {
  const body = String(text ?? '');
  if (!body.trim()) return 'receipt is empty';
  if (!VERSION_RE.test(body)) return 'no `codeintel X.Y.Z` line — the receipt never names its producer';
  if (!BUILD_RE.test(body)) return 'no `sha=<hex>` build identity — a verdict without its build is CANNOT-COMPARE';
  // A receipt that publishes a population (the walk count) must publish the counts themselves,
  // because "the population is JS" is a claim and `population_counts` is the measurement.
  if (/popula[cç][aã]o|population/i.test(body) && !POPULATION_RE.test(body)) {
    return 'mentions a population without `population_counts` beside it';
  }
  return null;
}

/** The same text with every build identity removed — the negative fixture, built from the real one. */
export function strippedOfBuild(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !BUILD_RE.test(line) && !VERSION_RE.test(line))
    .join('\n');
}
