// ---- 1. syntax, line endings, manifest ------------------------------------
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PRODUCT_JS } from '../product.mjs';

export const syntaxChecks = [
  {
    name: 'syntax',
    run(ctx) {
      ctx.assert(PRODUCT_JS.length > 0, 'syntax has no product files to check');
      for (const rel of PRODUCT_JS) {
        ctx.assert(existsSync(path.join(ctx.ROOT, rel)), `missing product file: ${rel}`);
        const r = spawnSync(process.execPath, ['--check', path.join(ctx.ROOT, rel)], {
          encoding: 'utf8',
        });
        ctx.assert(r.status === 0, `${rel}: ${String(r.stderr || r.stdout || '').trim().slice(0, 240)}`);
      }
      return `${PRODUCT_JS.length} files`;
    },
  },
  {
    // MEASURED 2026-11-13: a Python edit rewrote every file it touched with CRLF,
    // and `cold-cover-fixture` then failed with "the enforcement mutation did not
    // apply" — its mutations are written LF-only. That is a HARNESS defect wearing
    // a product failure's clothes. Every source suite reads these files and
    // several mutate them by exact text, so the checkout's shape is a contract.
    name: 'line-endings',
    run(ctx) {
      const files = ['kick-overlay/twitch-adblock.js', 'kick-overlay/content.js', 'kick-overlay/player-bridge.js',
        'kick-overlay/adblock-bridge.js', 'kick-overlay/background.js', 'kick-overlay/popup.js'];
      const bad = files.filter((rel) => {
        const d = ctx.read(rel);
        return d.includes('\r\n');
      });
      ctx.assert(bad.length === 0, `CRLF in ${bad.join(', ')} — an editing tool rewrote these; suites mutate them by exact LF text`);
      return `${files.length} files LF`;
    },
  },
  {
    name: 'manifest',
    run(ctx) {
      const manifest = JSON.parse(ctx.read('kick-overlay/manifest.json'));
      ctx.assert(manifest.manifest_version === 3, 'manifest_version must be 3');
      ctx.assert(/^\d+\.\d+\.\d+$/.test(manifest.version), `bad version: ${manifest.version}`);
      for (const rel of ['background.js', 'content.js', 'twitch-adblock.js', 'player.html', 'popup.html']) {
        ctx.assert(existsSync(path.join(ctx.EXT, rel)), `missing kick-overlay/${rel}`);
      }
      ctx.state.manifest = manifest;
      return `${manifest.name} ${manifest.version}`;
    },
  },
];
