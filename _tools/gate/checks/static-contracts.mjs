// ---- 2. static product contracts and their negative arms -------------------
import { existsSync } from 'node:fs';
import path from 'node:path';

// The page must never reload itself. This detector is intentionally shared by
// the real check and its negative arm, so the arm proves THIS detector.
// ONE exception is sanctioned and it is a tool against the opposite defect: a
// tab opened before an update runs the old content script forever, because
// loading the folder does not re-inject it (owner 2026-11-12: `boot {ver:'0.8.79'}`
// while the manifest was three waves ahead). The site must carry the marker
// `ko-versioned-reload`, must be the ONLY one, and its two guards are arms in
// content-fix-test.cjs (P2p). Any unmarked reload still fails this check, and the
// negative arm proves it.
const AUTO_REFRESH = /(?:window\.)?location\.(?:reload\s*\(|href\s*=\s*(?:window\.)?location\.href)|http-equiv\s*=\s*["']refresh["']/i;
const AUTO_FILE_CANDIDATES = [
  'kick-overlay/content.js',
  'kick-overlay/twitch-adblock.js',
  'kick-overlay/background.js',
  'kick-overlay/player-bridge.js',
  'kick-overlay/popup.js',
  'kick-overlay/player.html',
  'kick-overlay/popup.html',
];
const VERSIONED_RELOAD_MARK = 'ko-versioned-reload';

function autoFiles(ctx) {
  return AUTO_FILE_CANDIDATES.filter((rel) => existsSync(path.join(ctx.ROOT, rel)));
}

function autoRefreshHits(text) {
  if (!AUTO_REFRESH.test(text)) return false;
  const lines = String(text).split('\n');
  // every match is guilty unless ITS OWN LINE carries the mark, and only one may
  let marked = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const re = new RegExp(AUTO_REFRESH.source, 'gi');
    if (!re.test(lines[i])) continue;
    const ctx = lines[i];
    if (ctx.includes(VERSIONED_RELOAD_MARK)) marked += 1;
    else return true;
  }
  return marked > 1;
}

// ---- 4. cold-open standby contract ---------------------------------------
// These are the load-bearing markers of the 0.8.31/0.8.32 cold path. The
// negative arm removes one and requires the detector to fail.
const COLD_CONTRACT = [
  'prewarm.fast',
  'lastStandbyRequestAt',
  'graceMs',
  // 0.8.111: each retry names its author, so the ring says WHO asked again.
  "requestStandby(0, false, 'cold-start'), 200",
  "requestStandby(0, false, 'cold-start'), 1000",
  "requestStandby(0, false, 'cold-start'), 2500",
  "requestStandby(0, false, 'cold-start'), 5000",
  // The old marker here was `startLevel: 0`, which pinned the lowest rendition:
  // a cold swap showed 360p while the ad ran at 1080p (owner report 2026-11-20).
  // The contract is now ABR un-pinned FIRST and the chosen level published.
  'startLevel: -1',
  'standby-level',
];

function coldText(ctx) {
  return [ctx.read('kick-overlay/twitch-adblock.js'), ctx.read('kick-overlay/player-bridge.js')].join('\n');
}

function coldContract(text) {
  const missing = COLD_CONTRACT.filter((marker) => !text.includes(marker));
  if (missing.length) throw new Error(`missing markers: ${missing.join(', ')}`);
  return `${COLD_CONTRACT.length} markers`;
}

// ---- 6. copy slop --------------------------------------------------------
// AGENTS.md forbids AI-slop patterns. This is a smoke test, not a detector for
// every kind of bad prose; the negative arm proves the patterns fire.
const SLOP_PATTERNS = [
  /\bnot just\b/i,
  /\bisn't just\b/i,
  /\bnot only\b/i,
  /\bnão é só\b/i,
  /\bnão é apenas\b/i,
  /\bthe goal is not\b/i,
  /\bo objetivo não é\b/i,
  /\bunlock\b/i,
  /\btransform\b/i,
  /\belevate\b/i,
  /\bempower\b/i,
  /\bstreamline\b/i,
  /\bseamless\b/i,
  /\bdelv(?:e|ing)\b/i,
  /\btapestry\b/i,
  /\bpivotal\b/i,
  /\btestament\b/i,
  /\u2014/,
];

function slopHits(text) {
  return SLOP_PATTERNS.filter((re) => re.test(text)).map((re) => String(re));
}

export const staticContractChecks = [
  {
    name: 'no-auto-refresh',
    run(ctx) {
      const files = autoFiles(ctx);
      const hits = files.filter((rel) => autoRefreshHits(ctx.read(rel)));
      ctx.assert(!hits.length, `auto-refresh found in ${hits.join(', ')}`);
      return `${files.length} files checked`;
    },
  },
  {
    name: 'no-auto-refresh.neg-arm',
    run(ctx) {
      ctx.assert(autoRefreshHits('window.location.reload();'), 'detector did not reject a reload');
      ctx.assert(autoRefreshHits('// ko-versioned-reload\nlocation.reload();'), 'detector accepted a reload whose MARK is only on another line');
      ctx.assert(autoRefreshHits('location.reload(); // ko-versioned-reload\nlocation.reload(); // ko-versioned-reload'), 'detector accepted two marked reloads');
      ctx.assert(autoRefreshHits('<meta http-equiv="refresh" content="1">'), 'detector did not reject a meta refresh');
      return 'detector rejected reload and meta refresh';
    },
  },
  {
    name: 'cold-contract',
    run(ctx) {
      return coldContract(coldText(ctx));
    },
  },
  {
    name: 'cold-contract.neg-arm',
    run(ctx) {
      let rejected = false;
      try {
        coldContract(coldText(ctx).replace('prewarm.fast', 'removed-on-purpose'));
      } catch {
        rejected = true;
      }
      ctx.assert(rejected, 'detector accepted a mutated cold contract');
      return 'detector rejected the missing prewarm.fast';
    },
  },
  {
    // ---- 5. docs / product decision --------------------------------------
    name: 'docs',
    run(ctx) {
      ctx.assert(existsSync(path.join(ctx.EXT, 'PLAYER-1TO1-RESEARCH.md')), 'missing player 1:1 research');
      ctx.assert(existsSync(path.join(ctx.ROOT, 'README.en.md')), 'missing English README');
      const readme = ctx.read('README.md');
      ctx.assert(readme.includes('Abrir no site oficial'), 'README does not mention the official-site shortcut');
      ctx.assert(readme.includes('PLAYER-1TO1-RESEARCH.md'), 'README does not point to the research');
      return 'research + official-site shortcut documented';
    },
  },
  {
    name: 'copy-slop',
    run(ctx) {
      const files = ['README.md', 'README.en.md'].filter((rel) => existsSync(path.join(ctx.ROOT, rel)));
      const hits = [];
      for (const rel of files) {
        for (const pattern of slopHits(ctx.read(rel))) hits.push(`${rel}: ${pattern}`);
      }
      ctx.assert(!hits.length, hits.join('; '));
      return `${files.length} files`;
    },
  },
  {
    name: 'copy-slop.neg-arm',
    run(ctx) {
      const sample = 'Not just a player. Unlock the future.';
      ctx.assert(slopHits(sample).length >= 2, 'detector missed the slop sample');
      return 'detector rejected the slop sample';
    },
  },
];
