// ---- 5. instruments: the census and the live-state probe contract -----------
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const instrumentChecks = [
  {
    // ---- 6b. silent-decision census ---------------------------------------
    // A GUARD THAT RETURNS WITHOUT A ROW IS THE CLASS EVERY SURPRISE CAME FROM.
    // Measured 2026-11-20: `adUiHoldTick()` bailed out on `overlay.standby` with no
    // log line and a 62.6 s ad played; three freeze defects of 0.8.88 sat behind a
    // green suite for the same reason. The ring cannot say a silent guard happened,
    // so the only way to find one was to read the source — which is exactly the
    // surprise the owner asked about. This check does not demand that all 119 exits
    // log; it pins the measured count and refuses GROWTH, so a new silent guard has
    // to be argued for in the budget file instead of sneaking in.
    name: 'silent-census',
    run(ctx) {
      const tool = path.join(ctx.ROOT, '_tools/ko-census.mjs');
      ctx.assert(existsSync(tool), 'missing _tools/ko-census.mjs');
      const r = spawnSync(process.execPath, [tool, '--gate'], {
        cwd: ctx.ROOT,
        encoding: 'utf8',
      });
      const out = String(r.stdout || '') + String(r.stderr || '');
      ctx.assert(r.status === 0, `census refused:\n${out.trim().slice(-500)}`);
      const m = /RESULT PASS\s+guardShaped=(\d+)\s+unexercisedState=(\d+)/.exec(out);
      ctx.assert(m, `census printed no verdict:\n${out.trim().slice(-400)}`);
      return `guard-shaped silent exits=${m[1]}, ad-path state fields no arm touches=${m[2]}; a planted silent guard makes this check FAIL`;
    },
  },
  {
    // ---- 6b. live state probe --------------------------------------------
    // The ring holds TRANSITIONS, so a state that is stably wrong emits nothing and
    // "is it stuck right now" had no instrument (measured 2026-11-20: a native
    // element sat frozen for 70 s with no row). `ko-snapshot` reads what the page
    // publishes, so THIS check can only prove its CONTRACT: every attribute it
    // reads is still written somewhere, and every verdict it can print still has
    // its branch. The probe is deliberately NOT spawned here: a live reading needs
    // the owner Chrome and belongs to the project-harness job, not this static gate.
    name: 'live-state-probe',
    run(ctx) {
      const tool = path.join(ctx.ROOT, '_tools/ko-snapshot.mjs');
      ctx.assert(existsSync(tool), 'missing _tools/ko-snapshot.mjs');
      const src = ctx.read('_tools/ko-snapshot.mjs');
      // Full attribute names, hyphens included: `[a-z]+` stopped at the first
      // hyphen, so `data-ko-audio-m` counted as `audio` and the check reported 3
      // readers where the probe reads 7. A census that undercounts its own subject
      // is the same defect class it exists to catch.
      const readers = [...src.matchAll(/data-ko-([a-z0-9]+(?:-[a-z0-9]+)*)/g)]
        .map((m) => m[1]);
      const uniq = [...new Set(readers)];
      ctx.assert(uniq.length >= 6, `probe reads only ${uniq.length} published attribute(s): ${uniq.join(', ')}`);

      const producers = ['kick-overlay/content.js', 'kick-overlay/adblock-bridge.js']
        .map((f) => ctx.read(f)).join('\n');
      const orphan = uniq.filter((a) => !producers.includes(`data-ko-${a}`));
      ctx.assert(!orphan.length, `probe reads attribute(s) nothing writes: ${orphan.join(', ')}`);

      for (const cls of ['FROZEN', 'PAUSED', 'REPEAT', 'PLAYING']) {
        ctx.assert(src.includes(cls), `probe lost the ${cls} verdict branch`);
      }
      // A LAYER THAT OWNS THE PICTURE IS THE SURFACE. The probe once read the
      // page's own <video> — paused BY DESIGN under `player=kick` — and printed
      // `-> PAUSED` while the kick frame reported Playing at lat 1.65. The branch
      // must still exist in the source; whether it fires needs the owner Chrome.
      ctx.assert(src.includes('SURFACE=FRAME'), 'probe lost the SURFACE=FRAME branch for an owning layer');
      ctx.assert(/no Twitch\/YouTube tab|NOT measurable from the DOM/.test(src), 'probe lost its no-tab / DOM-limits verdict branch');
      return `${uniq.length} published attribute(s) each with a writer, SURFACE=FRAME branch present; probe NOT spawned (static contract only)`;
    },
  },
];
