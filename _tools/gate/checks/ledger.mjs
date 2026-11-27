// ---- 6. bug ledger: states, evidence and version honesty -------------------
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// States are explicit. `fixed` is allowed; `verified` needs an independent
// verifier, and `arm-verified` is the narrower claim: the negative arm was
// executed and independently reviewed, while the end-to-end measurement that
// needs the owner's own Chrome is still outstanding and named in
// `owner_validation`. The receipt prints FIXED, NOT VERIFIED only for a fix
// with no measured arm, and ARM-VERIFIED, LIVE PENDING for the narrow one, so
// neither is silent.
const LEDGER_STATES = new Set([
  'reported',
  'reproduced',
  'cause-isolated',
  'fixed',
  'arm-verified',
  'verified',
  'recurrence-watch',
]);

const LEDGER_FAILURE_MARKERS = ['Failed to fetch', 'Uncaught', 'TypeError'];

function ledgerEvidenceArtifacts(bug) {
  const paths = [];
  for (const entry of Array.isArray(bug.evidence) ? bug.evidence : []) {
    const re = /_evidence[\\/][^\s"'`,]+/g;
    let m;
    while ((m = re.exec(String(entry)))) paths.push(m[0].replace(/\\/g, '/'));
  }
  for (const key of ['arms_artifact', 'reachability_artifact']) {
    if (typeof bug[key] === 'string' && bug[key].startsWith('_evidence/')) paths.push(bug[key]);
  }
  return [...new Set(paths)];
}

export const ledgerChecks = [
  {
    name: 'bug-ledger',
    run(ctx) {
      const raw = JSON.parse(ctx.read('_tools/ko-bug-ledger.json'));
      ctx.assert(raw && Array.isArray(raw.bugs), 'bug ledger needs a bugs array');
      for (const bug of raw.bugs) {
        ctx.assert(bug.id && bug.title, 'bug needs id and title');
        ctx.assert(LEDGER_STATES.has(bug.state), `${bug.id}: bad state ${bug.state}`);
        ctx.assert(Array.isArray(bug.evidence) && bug.evidence.length > 0, `${bug.id}: fixed without evidence`);
        ctx.assert(bug.falsifier, `${bug.id}: hypothesis without falsifier`);
        if (bug.state === 'verified' || bug.state === 'arm-verified') {
          ctx.assert(bug.verified_by, `${bug.id}: verified without verifier`);
          ctx.assert(bug.verified_by !== bug.author, `${bug.id}: verifier is the author`);
          ctx.assert(bug.arms_artifact, `${bug.id}: verified without an arm artifact path`);
          ctx.assert(bug.verified_at, `${bug.id}: verified without a date`);
          // Reachability: `verified` needs a real-browser run that actually reached the
          // branch; `arm-verified` needs a reachability attempt that FAILED to reach it.
          // The weaker state cannot be chosen for convenience, only earned by a recorded
          // NO-VERDICT, and the stronger one only by a recorded PASS.
          ctx.assert(bug.reachability_artifact, `${bug.id}: no reachability artifact`);
          const rv = bug.reachability_verdict;
          ctx.assert(rv === 'PASS' || rv === 'NO-VERDICT', `${bug.id}: reachability_verdict must be PASS or NO-VERDICT`);
          ctx.assert(
            (bug.state === 'verified' && rv === 'PASS') || (bug.state === 'arm-verified' && rv === 'NO-VERDICT'),
            `${bug.id}: state ${bug.state} contradicts reachability verdict ${rv}`,
          );
        }
        if (bug.state === 'arm-verified') {
          ctx.assert(
            bug.owner_validation,
            `${bug.id}: arm-verified without naming the owner measurement still outstanding`,
          );
        }
      }
      ctx.state.ledger = raw;
      ctx.state.ledgerLoaded = true;
      return `${raw.bugs.length} bug(s)`;
    },
  },
  {
    // ---- 6b. ledger evidence and version honesty -------------------------
    // A `verified` claim is a receipt, not a mood: it must name an artifact that
    // exists on disk, and that artifact must not be a fetch failure or a stub.
    // A fixed_in must name a version the manifest actually shipped; invented
    // versions let a row point at a build nobody can install. History is parsed
    // once, keeping at most 400 version lines (the full -p output is ~2800 lines).
    name: 'ledger-evidence',
    run(ctx) {
      const raw = JSON.parse(ctx.read('_tools/ko-bug-ledger.json'));
      const bugs = Array.isArray(raw.bugs) ? raw.bugs : [];
      const claimed = bugs.filter((b) => b.verified === true || /^\d{4}-\d\d-\d\d$/.test(String(b.verified || '')));
      for (const bug of claimed) {
        const paths = ledgerEvidenceArtifacts(bug);
        ctx.assert(paths.length, `${bug.id}: verified without an _evidence artifact path`);
        const found = paths.filter((rel) => existsSync(path.join(ctx.ROOT, rel)));
        ctx.assert(found.length, `${bug.id}: verified artifact missing: ${paths.join(', ')}`);
        for (const rel of found) {
          const body = readFileSync(path.join(ctx.ROOT, rel), 'utf8');
          const marker = LEDGER_FAILURE_MARKERS.find((m) => body.includes(m));
          ctx.assert(!marker, `${bug.id}: ${rel} contains failure marker "${marker}"`);
          ctx.assert(body.trim().toLowerCase() !== 'missing', `${bug.id}: ${rel} contains only "missing"`);
        }
      }
      const history = spawnSync('git', ['-C', ctx.ROOT, 'log', '-p', '--', 'kick-overlay/manifest.json'], { timeout: 120000, killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      ctx.assert(history.status === 0, `manifest history unavailable: ${String(history.stderr || '').trim().slice(0, 160)}`);
      const versions = new Set(history.stdout.split('\n')
        .filter((line) => /^[+-]\s*"version":\s*"\d+\.\d+\.\d+"/.test(line))
        .slice(0, 400)
        .map((line) => String(line.match(/(\d+\.\d+\.\d+)/)[1])));
      ctx.assert(versions.size > 0, 'no manifest versions parsed');
      for (const bug of bugs) {
        if (bug.fixed_in == null || bug.fixed_in === 'unreleased') continue;
        const named = [...String(bug.fixed_in).matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0]);
        // Descriptive pointers (a tool path, not a build) are not version claims.
        if (!named.length) continue;
        const invented = named.filter((v) => !versions.has(v));
        ctx.assert(!invented.length, `${bug.id}: fixed_in names version(s) never shipped: ${invented.join(', ')}`);
      }
      return `${claimed.length} verified row(s) with artifact evidence; ${versions.size} manifest version(s)`;
    },
  },
];
