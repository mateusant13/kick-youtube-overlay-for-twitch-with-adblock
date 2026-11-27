#!/usr/bin/env node
// Fast evidence gate for the Kick Overlay extension.
//
// This is the JS-extension adaptation of the Sotto observability rules:
//   - one command that produces a receipt with the command and its output;
//   - every detector has a negative arm that is actually executed;
//   - a bug ledger that refuses to call a fix "verified" without independent
//     evidence, and prints FIXED, NOT VERIFIED when it is only fixed;
//   - an explicit NOT MEASURED section.
//
// This gate is deliberately static: no browser, no network, no user's Chrome.
// The live suite is still `node _tools/ko-harness.mjs check ...`.
//
// LAYOUT: this file is the runner and nothing else. The ordered check list is
// `_tools/gate/checks/index.mjs`; each check body is a module under
// `_tools/gate/checks/`; shared primitives are `_tools/gate/registry.mjs`; the
// receipt is `_tools/gate/receipt.mjs`. The check names, PASS/FAIL lines and the
// RESULT line are the gate's contract and did not change when the bodies moved.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext } from './gate/registry.mjs';
import { CHECKS } from './gate/checks/index.mjs';
import { verifiedArtifacts } from './gate/checks/artifacts.mjs';
import { prepareReceipt, finalizeReceipt, crashReceipt } from './gate/receipt.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ctx = makeContext(ROOT);

ctx.runAll(CHECKS);
// The arm artifacts this run captured have to exist before the check that binds
// a ledger claim to them can pass.
try {
  prepareReceipt(ctx);
  ctx.runCheck(verifiedArtifacts.name, verifiedArtifacts.run);
  finalizeReceipt(ctx);
} catch (error) {
  // A throw here used to abort with the previous receipt still on disk, so the
  // artifact said PASS beside a crashed run. crashReceipt writes FAIL and exits 1.
  crashReceipt(ctx, error);
}
