// ---- 8. per-bug artifact binding ------------------------------------------
//
// Every bug that claims a measured arm must point at an artifact this run just
// wrote, and that artifact must carry a RED/mutation line. Deleting a harness's
// negative arm, or pointing the ledger at a stale file, turns this check RED.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const verifiedArtifacts = {
  name: 'verified-artifacts',
  run(ctx) {
    const { state, ROOT } = ctx;
    const armArtifacts = state.armArtifacts;
    ctx.assert(state.ledgerLoaded, 'bug-ledger did not load; refusing to verify artifacts against an empty ledger');
    const badArms = armArtifacts.filter((a) => a.check !== 'reachability' && a.status !== 'PASS');
    ctx.assert(badArms.length === 0, `captured arm(s) from a failed run: ${badArms.map((a) => a.check + '=' + a.status).join(', ')}`);
    const commitCache = new Map();
    const claimed = state.ledger.bugs.filter((b) => b.state === 'verified' || b.state === 'arm-verified');
    for (const bug of claimed) {
      ctx.assert(bug.arms_artifact, `${bug.id}: no arms_artifact`);
      const abs = path.join(ROOT, bug.arms_artifact);
      ctx.assert(existsSync(abs), `${bug.id}: missing ${bug.arms_artifact}`);
      const body = readFileSync(abs, 'utf8');
      ctx.assert(/RED|mutation/i.test(body), `${bug.id}: ${bug.arms_artifact} has no RED/mutation line`);
      const generated = /generated:\s*(\S+)/.exec(body);
      ctx.assert(generated, `${bug.id}: artifact has no generated stamp`);
      const ageH = (Date.now() - Date.parse(generated[1])) / 3600e3;
      ctx.assert(ageH < 24, `${bug.id}: artifact is ${ageH.toFixed(1)} h old; re-run the gate`);

      // Reachability artifacts come from a browser run, so they are not regenerated
      // by this gate and cannot be age-failed; they must exist and agree with the
      // verdict the ledger claims. The receipt prints their age so nobody reads a
      // three-day-old browser run as a live measurement.
      const rAbs = path.join(ROOT, bug.reachability_artifact);
      ctx.assert(
        existsSync(rAbs),
        `${bug.id}: missing ${bug.reachability_artifact}; regenerate it with node _tools/ko-real-arm-${bug.id === 'KO-20261023-01' ? 'd1' : 'd2'}.mjs against the guest harness`,
      );
      const rBody = readFileSync(rAbs, 'utf8');
      ctx.assert(
        rBody.includes(`RESULT ${bug.reachability_verdict}`),
        `${bug.id}: ${bug.reachability_artifact} does not say RESULT ${bug.reachability_verdict}`,
      );
      // A reachability record from before the source changed says nothing about the
      // code that shipped afterwards: re-running the arm script is the price of
      // keeping the claim.
      const srcLines = [...body.matchAll(/^- source: (\S+) sha256=/gm)].map((m) => m[1]);
      ctx.assert(srcLines.length > 0, `${bug.id}: ${bug.arms_artifact} names no source file`);
      const reachMtime = statSync(rAbs).mtimeMs / 1000;
      for (const rel of srcLines) {
        let committed = commitCache.get(rel);
        if (committed === undefined) {
          const log = spawnSync('git', ['-C', ROOT, 'log', '-1', '--format=%ct', '--', rel], { encoding: 'utf8' });
          committed = Number(String(log.stdout || '').trim());
          commitCache.set(rel, committed);
        }
        if (!Number.isFinite(committed) || !committed) continue; // untracked source: nothing to compare
        ctx.assert(
          reachMtime >= committed,
          `${bug.id}: ${bug.reachability_artifact} is older than the last change to ${rel} (${new Date(committed * 1000).toISOString()}); re-run node _tools/ko-real-arm-${bug.id === 'KO-20261023-01' ? 'd1' : 'd2'}.mjs`,
        );
      }
      const ageDays = (Date.now() - statSync(rAbs).mtimeMs) / 86400e3;
      armArtifacts.push({
        id: bug.id,
        path: bug.reachability_artifact,
        check: 'reachability',
        status: bug.reachability_verdict,
        expected_red: null,
        age_days: +ageDays.toFixed(2),
        after_source_change: true,
      });
    }
    return `${claimed.length} claim(s) bound to a fresh arm artifact and a reachability record`;
  },
};
