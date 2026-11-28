// Ordered check registry.
//
// `_tools/ko-verify.mjs` runs exactly what this array names, left to right, so
// moving a check into a module cannot change the receipt's order or the check
// count. `verified-artifacts` is deliberately NOT here: it needs the arm
// artifacts this run wrote, so the runner executes it between
// `prepareReceipt()` and `finalizeReceipt()`.
import { syntaxChecks } from './syntax.mjs';
import { staticContractChecks } from './static-contracts.mjs';
import { suiteChecks } from './suites.mjs';
import { toolingChecks } from './tooling.mjs';
import { vacuousGreen } from './vacuous-green.mjs';
import { instrumentChecks } from './instruments.mjs';
import { ledgerChecks } from './ledger.mjs';
import { revivalChecks } from './revival.mjs';
import { receiptChecks } from './receipts.mjs';

export const CHECKS = [
  ...syntaxChecks,
  ...staticContractChecks,
  ...suiteChecks,
  ...toolingChecks,
  vacuousGreen,
  ...instrumentChecks,
  ...ledgerChecks,
  ...revivalChecks,
  ...receiptChecks,
];
